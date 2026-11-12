const { createLocator, REQUIRED } = require('../claude-runtime/locator.cjs');

// The CLI the native path runs, from claude-runtime's locator: `locator` is main's shared one (`fresh` asks it to read
// the stored Windows PATH and search again first, `throttled` at most once a minute); without one, a locator of these
// options searches afresh.
// `missing` keeps its meaning for every caller: no usable native CLI. `reason` says why: `not_found`, or a file was
// found (`found`) whose version check timed out (`elapsedMs`), failed to run (`error` names how) or printed no version.
// A `not_found` also says where it looked: how many PATH folders (inherited and stored) and the install folders by
// name, home written as ~; `incomplete` names an npm package found without its native program. One found says where
// (`via`, `fileShown`); when the terminal runs another, older one, `notice` says so and `split` describes it.
async function inspectClaudeExecutable({ locator, fresh = !locator, throttled = false, ...options } = {}) {
  const using = locator || createLocator(options);
  const found = await (fresh ? using.refresh(options, { throttled }) : using.locate(options));
  const { native, terminal } = found;
  if (native) {
    return { status: 'ok', version: native.version, required: REQUIRED, file: native.file, via: native.via, fileShown: native.fileShown,
      ...(found.reason === 'cli_split_versions' ? { notice: found.reason, split: { terminal: { version: terminal.version, via: terminal.via, fileShown: terminal.fileShown } } } : {}) };
  }
  if (found.reason === 'too_old') return { status: 'too_old', version: found.version, required: REQUIRED, file: null };
  const missing = { status: 'missing', version: null, required: REQUIRED, file: null };
  if (found.reason !== 'not_found') return { ...missing, ...found.failure };
  return { ...missing, reason: 'not_found', pathFolders: found.pathFolders, searched: found.searched, ...(found.incomplete ? { incomplete: found.incomplete } : {}) };
}
async function resolveClaudeExecutable(options) {
  const result = await inspectClaudeExecutable(options);
  if (result.status === 'too_old') throw Object.assign(new Error('Claude Code 版本过低，请升级到 2.1.317 或更高'), { code: 'native_cli_required', outdated: true });
  if (result.reason && result.reason !== 'not_found') throw Object.assign(new Error('Claude Code 检查没有通过，无法通过 API 运行'), { code: 'native_cli_required', unverified: true });
  return result.file;
}
module.exports = { resolveClaudeExecutable, inspectClaudeExecutable };
