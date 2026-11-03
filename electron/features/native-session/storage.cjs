const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const warnings = new Map();
function recoverJson(file, fallback) {
  const resolved = path.resolve(file);
  try { fs.renameSync(resolved, `${resolved}.${Date.now()}-${randomUUID()}.corrupt`); } catch { }
  warnings.set(resolved, '原生会话记录损坏，已隔离并恢复默认设置。');
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
  return [...new Set(found.map(([, message]) => message))];
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
