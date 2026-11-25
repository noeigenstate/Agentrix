const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const warnings = new Map();
function recoverJson(file, fallback) {
  const resolved = path.resolve(file);
  let quarantined = false;
  try { fs.renameSync(resolved, `${resolved}.${Date.now()}-${randomUUID()}.corrupt`); quarantined = true; } catch { }
  const message = path.basename(file) === 'settings.json'
    ? '原生会话设置损坏，已使用默认设置。'
    : '原生会话记录损坏，已使用空记录；运行方式设置未改变。';
  warnings.set(resolved, [message, quarantined ? '损坏的文件已隔离保留。' : '损坏的文件无法隔离，原文件已保留。']);
  return structuredClone(fallback);
}
const retryableRead = new Set(['EBUSY', 'EPERM', 'EMFILE']);
const retryWait = new Int32Array(new SharedArrayBuffer(4));
function readContents(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = fs.openSync(file, 'r');
      try { return fs.fstatSync(fd).size > 16 * 1024 * 1024 ? '' : fs.readFileSync(fd, 'utf8'); }
      finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (!retryableRead.has(error.code) || attempt === 3) throw error;
      Atomics.wait(retryWait, 0, 0, 10 * 2 ** attempt);
    }
  }
}
function readJson(file, fallback, { validate = () => true } = {}) {
  const text = readContents(file);
  if (text === null) return structuredClone(fallback);
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return recoverJson(file, fallback);
  }
  return validate(value) ? value : recoverJson(file, fallback);
}
function recoveryWarnings(directory, clear = false) {
  const parent = path.resolve(directory), found = [...warnings].filter(([file]) => path.dirname(file) === parent);
  if (clear) for (const [file] of found) warnings.delete(file);
  return [...new Set(found.flatMap(([, messages]) => messages))];
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
module.exports = { readJson, writeJson, recoveryWarnings };
