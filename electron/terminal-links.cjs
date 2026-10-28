const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { resolveProjectPath } = require('./project-files.cjs');

const withoutPosition = value => value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');

function linkPathText(target, stripPosition = false) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target)) throw new Error('无效的链接。');
  let value = target.trim();
  const pairs = { '"': '"', "'": "'", '`': '`', '<': '>', '(': ')', '[': ']', '{': '}', '（': '）', '「': '」', '“': '”', '‘': '’' };
  // Strip presentation punctuation, retaining balanced parentheses and brackets inside a filename.
  let previous;
  do {
    previous = value;
    if (value !== '.' && value !== '..') value = value.replace(/[.,;!?，。；：！？、]+$/, '').trim();
    if (stripPosition) value = withoutPosition(value);
    if (pairs[value[0]] && value.endsWith(pairs[value[0]])) value = value.slice(1, -1).trim();
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
    }
  } while (value !== previous);
  if (!value) throw new Error('无效的链接。');
  if (/^file:\/\//i.test(value)) value = fileURLToPath(new URL(value));
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value) && !/^[^:]+:\d+(?::\d+)?$/.test(value)) throw new Error('无效的链接。');
  return stripPosition ? withoutPosition(value) : value;
}

// Unlike an in-app preview, revealing a path may point outside the project. It never opens the file itself.
function resolveRevealPathText(root, target, home = os.homedir(), platform = process.platform) {
  let value = linkPathText(target, true);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform !== 'win32' && /^(?:[a-z]:[\\/]|\\\\)/i.test(value)) throw new Error('无效的链接。');
  value = value.replace(/\\/g, '/');
  if (/^~(?:\/|$)/.test(value)) value = paths.join(home, value.slice(1));
  return paths.resolve(root, value);
}

async function resolveRevealPath(project, target) {
  const filename = resolveRevealPathText(project.path, target);
  try {
    const stat = await fs.stat(filename);
    if (stat.isFile() || stat.isDirectory()) return { path: filename, directory: stat.isDirectory() };
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  throw new Error('未找到此路径。');
}

async function resolveTerminalLink(project, target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096 || /[\x00-\x1f\x7f]/.test(target)) throw new Error('无效的链接。');
  let value = target.trim();
  if (/^www\./i.test(value)) value = `https://${value}`;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error('无效的网页链接。');
    return { kind: 'external', url: url.href };
  }
  if (/^file:\/\//i.test(value)) value = linkPathText(value);
  else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('只支持网页链接和项目内文件。');
  const candidates = [value, withoutPosition(value)];
  // A Windows-style relative path (.\docs\a.md) names the same file on macOS, where \ is otherwise a filename character.
  if (path.sep === '/' && value.includes('\\') && !path.isAbsolute(value)) candidates.push(...candidates.map(candidate => candidate.replace(/\\/g, '/')));
  for (const candidate of new Set(candidates)) {
    const relativePath = path.relative(project.path, path.resolve(project.path, candidate));
    try {
      const resolved = await resolveProjectPath(project, relativePath);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) return { kind: 'directory', path: resolved };
      if (stat.isFile()) return { kind: 'file', path: relativePath.split(path.sep).join('/') };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && candidate === candidates.at(-1)) throw error;
    }
  }
  throw new Error('未找到链接文件。相对路径从当前项目根目录开始。');
}

module.exports = { resolveTerminalLink, resolveRevealPath, resolveRevealPathText };
