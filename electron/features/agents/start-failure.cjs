const os = require('node:os');
const { scrubText } = require('./skill-privacy.cjs');
const LIMIT = 300, HEAD = 160;
// Credentials scrubText has no rule for: HTTP authorization schemes, API key headers and secret query parameters.
const SECRETS = [
  [/\b(Authorization[ \t]*[:=][ \t]*(?:(?:Basic|Bearer|Token|Digest)[ \t]+)?)[^\s,;]+/gi, '$1<secret>'],
  [/\b(Basic[ \t]+)[A-Za-z0-9+/._~-]{8,}=*/g, '$1<secret>'],
  [/\b((?:x-api-key|api-key|x-auth-token)[ \t]*[:=][ \t]*)[^\s,;]+/gi, '$1<secret>'],
  [/([?&;](?:key|api[_-]?key|access[_-]?token|token|auth|sig|signature|secret|password|code)=)[^&\s#"'<>]+/gi, '$1<secret>'],
];
const local = (() => {
  try { const { username, homedir } = os.userInfo(); return { users: [username], homes: [homedir] }; }
  catch { return { users: [], homes: [os.homedir()] }; }
})();
const clip = (value, limit, fromEnd = false) => value.length <= limit ? value : fromEnd ? '…' + value.slice(1 - limit) : value.slice(0, limit - 1) + '…';
const line = value => value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
// Terminal escapes: OSC (titles, ]8;; hyperlinks with their URL) up to BEL or ST, then CSI (colours, cursor).
const plain = value => value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

// Credentials, terminal escapes, the SSH host's names and this computer's user and home, removed from process output.
const redactor = hosts => value => scrubText(SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), plain(value)), { ...local, hosts }).text;
// The last stderr lines as one redacted line within limit. The whole tail is redacted before it is split, so a secret
// spread over lines is still recognized; its end is kept over its start.
function stderrTail(stderr, { limit = LIMIT, hosts = [] } = {}) {
  return clip(redactor(hosts)(stderr).split(/\r?\n/).map(line).filter(Boolean).slice(-3).join(' / '), limit, true);
}

// Why a start failed, as one redacted line: the stage, the code or protocol error, the exit and the last stderr lines.
// The general failure sentence alone cannot be told apart, so it cannot be fixed.
function startupDetail(error, { stderr = '', processError = null, exitCode = null, signal = null } = {}, { hosts = [] } = {}) {
  const redact = redactor(hosts);
  const code = typeof error.code === 'string' ? error.code : Number.isInteger(error.code) ? `rpc ${error.code}` : null;
  const what = [...new Set([code, error.method && `${error.method} ${error.category || ''}`.trim(), error.message, error.serverMessage, processError]
    .filter(value => value && value !== 'rpc_rejected'))].join(', ');
  const exit = signal ? ` (signal ${signal})` : exitCode != null ? ` (exit ${exitCode})` : '';
  const head = clip(line(redact(`${error.stage ? error.stage + ': ' : ''}${what}${exit}`)), HEAD);
  const label = ' · stderr: ', tail = stderrTail(stderr, { limit: LIMIT - head.length - label.length, hosts });
  return tail ? head + label + tail : head;
}

// The end of a process's stderr as it arrives, bounded, for a failure that may come before any other output.
function stderrCollector(kept = 8192) {
  let text = '';
  return { push: chunk => { text = (text + chunk).slice(-kept); }, text: () => text };
}

module.exports = { startupDetail, stderrTail, stderrCollector };
