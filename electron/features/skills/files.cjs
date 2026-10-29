const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_BYTES, frontMatter } = require('./front-matter.cjs');

const MAX_IMPORT_BYTES = 8 * 1024 * 1024, MAX_IMPORT_FILES = 128;

function skillName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,119}$/u.test(value)
    || /\.$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error('无效的技能名称。');
  return value;
}

function metadata(text) {
  let front;
  try { front = frontMatter(text); } catch { throw new Error('技能文件过大或 front matter 格式无效。'); }
  if (!front) throw new Error('SKILL.md 需要 name 和 description front matter。');
  const field = key => {
    return (front.fields[key] || '').replace(/^[>|][+-]?\s*/, '').replace(/\s+/g, ' ').trim();
  };
  const name = skillName(field('name')), description = field('description');
  if (!description || description.length > 2000) throw new Error('请填写技能描述（最多 2000 字）。');
  return { name, description, title: field('title') || name, summary: field('summary') || description };
}

function draftText(draft) {
  skillName(draft?.name);
  if (typeof draft.description !== 'string' || !draft.description.trim() || draft.description.length > 2000 || typeof draft.text !== 'string') throw new Error('技能内容无效。');
  // The editor owns name/description; preserve other front matter and the entire body.
  const front = frontMatter(draft.text);
  const extra = front ? front.raw.replace(/^(?:name|description):[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*(?:\r?\n|$)/gm, '').trim() : '';
  const text = `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description.trim())}\n${extra ? extra + '\n' : ''}---\n${front ? front.body : draft.text}`;
  metadata(text);
  return text;
}

function readJson(file, fallback, report = () => {}, valid = value => value && typeof value === 'object' && !Array.isArray(value)) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!valid(value)) throw new SyntaxError('Invalid skills JSON structure.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      try { fs.copyFileSync(file, `${file}.corrupt-${randomUUID()}.bak`); }
      catch (backupError) { report(backupError); }
    }
    report(new Error(`Skipping skills JSON ${file}: ${error.message}`));
    return fallback;
  }
}

// Skills are writable folders. Refuse symlinks at the managed boundary, including SKILL.md itself, so
// imports, edits and deletion cannot escape through a skill supplied by an agent or an imported folder.
function checkedPath(root, name) {
  const folder = path.join(root, skillName(name)), file = path.join(folder, 'SKILL.md');
  for (const entry of [root, folder, file]) {
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('技能目录不能使用符号链接。');
  }
  return file;
}

function readText(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.size > MAX_BYTES) return null;
  if (!stat.isFile()) throw new Error('只能读取普通技能文件。');
  return fs.readFileSync(file, 'utf8');
}

function listFolder(root, report = () => {}, invalid = () => {}, parse = metadata) {
  const result = [];
  let folders;
  try {
    const stat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!stat) return result;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid skills folder: ${root}`);
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) { report(error); invalid(null); return result; }
  for (const entry of folders) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const file = checkedPath(root, entry.name), text = readText(file);
      if (text !== null) result.push({ folder: entry.name, path: file, text, ...parse(text, entry.name) });
      else invalid(entry.name);
    } catch (error) {
      // An agent may be halfway through writing a file. The debounced watcher/fallback retries it.
      invalid(entry.name); report(error);
    }
  }
  return result;
}

// Poll metadata only, asynchronously. Never read skill bodies (or walk a project's other files) on idle polls.
async function folderSignature(root, depth = 1) {
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory()) return `${stat.mode}:${stat.mtimeMs}:${stat.size}`;
    const entries = await fs.promises.readdir(root, { withFileTypes: true }), parts = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(root, entry.name);
      const info = entry.isSymbolicLink() ? await fs.promises.stat(file).catch(() => null) : entry;
      if (info?.isDirectory() && depth > 0) parts.push([entry.name, await folderSignature(file, depth - 1)]);
      else if (entry.name === 'SKILL.md') {
        const info = await fs.promises.stat(file);
        parts.push([entry.name, info.mtimeMs, info.ctimeMs, info.size, info.ino]);
      }
    }
    return JSON.stringify(parts);
  } catch (error) { return error.code || error.message; }
}

async function importFiles(folder) {
  const files = [];
  let bytes = 0, count = 0;
  const walk = async directory => {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('导入的技能不能使用符号链接。');
    const entries = await fs.promises.opendir(directory);
    for await (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.isDirectory() && entry.name.startsWith('.')) continue;
      if (++count > MAX_IMPORT_FILES) throw new Error(`技能导入最多 ${MAX_IMPORT_FILES} 个文件和文件夹。`);
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('导入的技能不能使用符号链接。');
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        bytes += (await fs.promises.stat(file)).size;
        if (bytes > MAX_IMPORT_BYTES) throw new Error('技能导入合计超过 8 MB。');
        files.push({ file, relative: path.relative(folder, file) });
      }
      else throw new Error('只能导入普通技能文件。');
    }
  };
  await walk(folder);
  return files;
}

// Skills share the app's atomic write (electron/atomic-write.cjs).
const { writeFileAtomic: writeFile } = require('../../atomic-write.cjs');

module.exports = { MAX_BYTES, MAX_IMPORT_BYTES, MAX_IMPORT_FILES, skillName, metadata, draftText, readJson, writeFile, checkedPath, readText, listFolder, folderSignature, importFiles };
