const path = require('node:path');
const { fs } = require('./disk.cjs');

async function recordTestFailure(error, file) {
  if (error.testLog === file) return error;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, '\n' + String(error.stack || error) + '\n', { mode: 0o600 });
  error.testLog = file;
  return error;
}

function testLogMessage(message, file, t) {
  return message + '\n' + t('测试日志：{path}', { path: file });
}

function failureMessage(error, t, limit = 1000) {
  const message = t(String(error.message || error)).slice(0, limit);
  return error.testLog ? testLogMessage(message, error.testLog, t) : message;
}

module.exports = { recordTestFailure, testLogMessage, failureMessage };
