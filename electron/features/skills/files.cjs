const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 512 * 1024;

function skillName(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,119}$/u.test(value)
    || /\.$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) throw new Error('无效的技能名称。');
  return value;
}

function metadata(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES || text.includes('\0')) throw new Error('技能文件过大或格式无效。');
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) throw new Error('SKILL.md 需要 name 和 description front matter。');
  const field = key => {
    const match = new RegExp(`^${key}:[ \\t]*(.*(?:\\r?\\n[ \\t]+.*)*)$`, 'm').exec(front[1]);
    let value = (match?.[1] || '').trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { throw new Error('技能 front matter 格式无效。'); } }
    else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    return value.replace(/^[>|][+-]?\s*/, '').replace(/\s+/g, ' ').trim();
  };
  const name = skillName(field('name')), description = field('description');
  if (!description || description.length > 2000) throw new Error('请填写技能描述（最多 2000 字）。');
  return { name, description };
}

function draftText(draft) {
  skillName(draft?.name);
  if (typeof draft.description !== 'string' || !draft.description.trim() || draft.description.length > 2000 || typeof draft.text !== 'string') throw new Error('技能内容无效。');
  // The editor owns name/description; preserve other front matter and the entire body.
  const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(draft.text);
  const extra = front ? front[1].replace(/^(?:name|description):[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*(?:\r?\n|$)/gm, '').trim() : '';
  const text = `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description.trim())}\n${extra ? extra + '\n' : ''}---\n${front ? draft.text.slice(front[0].length) : draft.text}`;
  metadata(text);
  return text;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
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
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('只能读取不超过 512 KB 的普通技能文件。');
  return fs.readFileSync(file, 'utf8');
}

function listFolder(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.lstatSync(root).isSymbolicLink()) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const file = checkedPath(root, entry.name), text = readText(file);
      if (text !== null) result.push({ folder: entry.name, path: file, text, ...metadata(text) });
    } catch (error) {
      // An agent may be halfway through writing a file. The debounced watcher/fallback retries it.
      if (error.code && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return result;
}

function importFiles(folder) {
  const files = [];
  const walk = directory => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('导入的技能不能使用符号链接。');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('导入的技能不能使用符号链接。');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push({ file, relative: path.relative(folder, file) });
      else throw new Error('只能导入普通技能文件。');
    }
  };
  walk(folder);
  return files;
}

module.exports = { MAX_BYTES, skillName, metadata, draftText, readJson, writeFile, checkedPath, readText, listFolder, importFiles };
