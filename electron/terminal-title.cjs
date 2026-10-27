// Capture Codex's configured session-id OSC title from this exact PTY. It
// gives same-folder terminals distinct owners without changing user config.
// Codex 0.162 caps the title at 32 characters, so the id arrives cut short as
// "01a12e29-6b04-7290-8dfc-96f77...": that leading part is reported as it is, and
// the session whose id starts with it is the one (sameThread).
class TerminalTitleTracker {
  constructor() { this.buffer = ''; }
  write(data) {
    this.buffer += data;
    const ids = [];
    const pattern = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match, end = 0;
    while ((match = pattern.exec(this.buffer))) {
      const value = match[1].trim();
      if (wholeThread(value)) ids.push(value);
      else {
        const cut = /^([a-f\d]{8}-[a-f\d-]{8,27})(?:\.\.\.|…)$/i.exec(value);
        if (cut) ids.push(cut[1]);
      }
      end = pattern.lastIndex;
    }
    if (end) this.buffer = this.buffer.slice(end);
    this.buffer = this.buffer.slice(-8192);
    return ids;
  }
}
// Whether a session id is the one a title reported, whole or cut short.
function sameThread(id, reported) {
  return typeof id === 'string' && typeof reported === 'string' && !!reported && id.toLowerCase().startsWith(reported.toLowerCase());
}
const wholeThread = id => typeof id === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id);
module.exports = { TerminalTitleTracker, sameThread, wholeThread };
