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
function readJson(file, fallback, { validate = () => true } = {}) {
  try {
    if (fs.statSync(file).size > 16 * 1024 * 1024) return recoverJson(file, fallback);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validate(value) ? value : recoverJson(file, fallback);
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    return recoverJson(file, fallback);
  }
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
