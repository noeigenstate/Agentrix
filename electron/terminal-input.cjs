// xterm sends protocol replies through onData too. Cursor positions, device
// attributes, focus reports and color replies do not mean the user typed a
// command at the PowerShell prompt. They must still be forwarded to the PTY.
const reply = /^(?:\x1b\[[?>]?[\d;]*(?:R|c|n|t)|\x1b\[[IO]|\x1b\](?:4;\d+|1[012]);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1bP[01]\+r[^\x1b]*\x1b\\)+$/;

function isTerminalResponse(data) {
  return data === '' || reply.test(data);
}

// Local commands do not imply a model turn; custom slash commands report turns through hooks or rollouts.
function isLocalCommand(text) {
  return /^[/!]/.test(text);
}

// Observe actual submissions. xterm sends focus, mouse and protocol reports on this same channel; none are
// new work. The text of each submission is kept in sent (until the next write) for the list of prompts;
// it is empty when the line was recalled from history, whose text the terminal never sees.
const TEXT_LIMIT = 4000;
class SubmissionTracker {
  constructor() { this.reset(); this.sent = []; }
  reset() { this.clearLine(); this.pasting = false; this.escape = ''; this.mouseBytes = 0; }
  clearLine() { this.characters = 0; this.hasText = false; this.history = false; this.text = ''; }
  type(character) {
    if (character >= ' ') { this.characters++; this.hasText ||= /\S/.test(character); }
    if (this.text.length < TEXT_LIMIT) this.text += character;
  }
  write(data) {
    let submitted = false;
    this.sent = [];
    // Escape pressed on its own (to interrupt, or to close a dialog) is a key, not the start of what is typed next:
    // only a sequence's own tail ([, ], P, O, or Enter for Alt+Enter) continues it.
    if (this.escape === '\x1b' && !/^[[\]PO\r]/.test(data)) this.escape = '';
    const enter = () => {
      if (this.hasText || this.history) { submitted = true; this.sent.push(this.history ? '' : this.text.trim()); }
      this.clearLine();
    };
    for (const character of data) {
      if (this.mouseBytes) { this.mouseBytes--; continue; }
      if (this.escape) {
        this.escape += character;
        if (['\x1b[', '\x1b]', '\x1bP', '\x1bO'].includes(this.escape)) continue;
        if (this.escape.startsWith('\x1b[')) {
          if (!/[@-~]/.test(character)) { if (this.escape.length > 128) this.escape = ''; continue; }
          const sequence = this.escape; this.escape = '';
          if (sequence === '\x1b[200~') this.pasting = true;
          else if (sequence === '\x1b[201~') this.pasting = false;
          else if (sequence === '\x1b[M') this.mouseBytes = 3;
          else if (!this.pasting && /^\x1b\[(?:1;\d+)?[AB]$/.test(sequence)) this.history = true;
          else if (!this.pasting && /^\x1b\[13(?:;1)?u$/.test(sequence)) enter();
          continue;
        }
        if (this.escape.startsWith('\x1b]') || this.escape.startsWith('\x1bP')) {
          if (character === '\x07' || this.escape.endsWith('\x1b\\') || this.escape.length > 4096) this.escape = '';
          continue;
        }
        if (!this.pasting && ['\x1bOA', '\x1bOB'].includes(this.escape)) this.history = true;
        if (!this.pasting && this.escape === '\x1bOM') enter();
        // Alt+Enter is a newline in Codex, not a submitted prompt.
        if (this.escape === '\x1b\r') this.type('\n');
        this.escape = ''; continue;
      }
      if (character === '\x1b') { this.escape = character; continue; }
      if (this.pasting) { if (character >= ' ') this.type(character); else if (character === '\r' || character === '\n') this.type('\n'); continue; }
      if (character === '\r') enter();
      else if (character === '\n') this.type('\n');
      else if (character === '\x03' || character === '\x15') this.clearLine();
      else if (character === '\x7f' || character === '\b') { this.characters = Math.max(0, this.characters - 1); if (!this.characters) this.hasText = false; this.text = Array.from(this.text).slice(0, -1).join(''); }
      else if (character >= ' ') this.type(character);
    }
    return submitted;
  }
}

// Each shell event uses its own pipe connection. A later connection can be
// delivered first, so startup must never overwrite a newer prompt-ready event.
function acceptShellEvent(session, event) {
  if (!['shell-ready', 'shell-prompt', 'codex-started', 'codex-exited'].includes(event.type)) return false;
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= (session.lastShellEventSequence || 0)) return false;
  session.lastShellEventSequence = event.sequence;
  return true;
}

// Command Prompt has no prompt hook, so its PROMPT prints an invisible OSC marker before each
// prompt: ESC ] 6973;Agentrix;prompt;<current directory> ESC \  (see integration/bootstrap.cmd).
// Output arrives in arbitrary chunks, so a marker split across chunks is held until it completes.
const PROMPT_MARKER = '\x1b]6973;Agentrix;prompt;';
class PromptMarkers {
  constructor() { this.tail = ''; }
  write(data) {
    const text = this.tail + data, found = [];
    let from = 0;
    for (;;) {
      const start = text.indexOf(PROMPT_MARKER, from);
      if (start < 0) { this.tail = ''; break; }
      const body = start + PROMPT_MARKER.length;
      const end = text.slice(body).search(/\x1b\\|\x07/);
      if (end < 0) { this.tail = text.length - start > 8192 ? '' : text.slice(start); break; }
      found.push(text.slice(body, body + end));
      from = body + end + 1;
    }
    // A partial marker prefix at the very end (e.g. "\x1b]69") is kept for the next chunk.
    if (!this.tail) for (let length = Math.min(PROMPT_MARKER.length - 1, text.length); length > 0; length--) {
      if (PROMPT_MARKER.startsWith(text.slice(-length))) { this.tail = text.slice(-length); break; }
    }
    return found;
  }
}

// PowerShell asks the terminal where the cursor is (ESC[6n) as it starts and as it draws a prompt, and drops
// keys that arrive before the answer. The window gives the answer; on a busy machine it can come after the
// first keys of a command typed or restored at once, and "codex" arrived as "odex". So input other than an
// answer waits while a question is open, at most a moment, and then goes in order.
const QUESTION = /\x1b\[\??6n/g, ANSWER = /\x1b\[\??\d+;\d+R/g;
class InputGate {
  constructor(write, { now = Date.now, wait = 1500, settle = 150, patience = 8000, stale = 350, shellOwnsInput = () => true } = {}) {
    Object.assign(this, { write, now, wait, settle, patience, stale, shellOwnsInput });
    this.questions = []; this.askedAt = 0; this.held = []; this.timer = null; this.expecting = false; this.settling = false;
  }
  // Questions still awaited. One given up on (timed out, or typed past) stays queued, so its late answer is
  // still matched to it and dropped rather than taken for the answer to a newer question.
  get open() { return this.questions.filter(question => !question.expired).length; }
  expire() { for (const question of this.questions) question.expired = true; }
  // What the shell printed.
  output(data) {
    const asked = String(data).match(QUESTION)?.length || 0;
    if (!asked) return;
    const now = this.now();
    this.questions = this.questions.filter(question => now - question.at <= 30000);
    for (let i = 0; i < asked; i++) this.questions.push({ at: now, expired: false });
    this.askedAt = now; this.expecting = false;
    // A restored command has no one waiting on it, so it gives a busy window (many terminals starting at once)
    // longer to answer than typed keys do.
    if (this.held.length) this.arm(this.settling ? this.patience : this.wait);
  }
  // What goes to the shell: keys, pasted text, or the window's answers.
  input(data) {
    if (isTerminalResponse(data)) {
      let answers = 0;
      const forwarded = data.replace(ANSWER, answer => {
        const question = this.questions.shift();
        answers++;
        // ConPTY stops waiting after ~500 ms, counted from before the question reached us; a late answer reaches
        // the prompt as keys and eats the next letter ("laude"). Dropping one it still wanted costs at most that
        // wait, so the cut-off is kept well under it. Codex's TUI waits longer and still needs its answer.
        if (question && this.shellOwnsInput() && (question.expired || this.now() - question.at > this.stale)) return '';
        return answer;
      });
      if (forwarded || !data) this.write(forwarded);
      if (answers && !this.open) this.answered();
      return;
    }
    if (this.held.length || (this.open && this.now() - this.askedAt < this.wait)) { this.held.push(data); if (!this.timer) this.arm(Math.max(0, this.askedAt + this.wait - this.now())); return; }
    this.expire(); this.write(data);
  }
  // A command restored at a new prompt. The prompt event is sent before PowerShell draws the prompt and asks,
  // so there is no question to wait behind yet, and "claude" arrived as "laude". The command waits for the
  // question to be asked (at most wait, for a shell that never asks) and answered (at most patience), and a
  // moment more in case another question follows.
  afterPrompt(data) {
    this.held.push(data); this.settling = true;
    if (!this.open) this.expecting = true;
    this.arm(this.open ? this.patience : this.wait);
  }
  answered() {
    if (this.expecting || !this.held.length) return;
    if (this.settling) { this.settling = false; this.arm(this.settle); } else this.release();
  }
  release() { clearTimeout(this.timer); this.timer = null; this.expecting = this.settling = false; const held = this.held; this.held = []; for (const data of held) this.write(data); }
  // An answer that never comes (no window showing the terminal yet) does not hold input for longer than wait.
  arm(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.expire(); this.release(); }, delay);
    this.timer.unref?.();
  }
  dispose() { clearTimeout(this.timer); this.timer = null; this.questions.length = 0; this.held = []; this.expecting = this.settling = false; }
}

module.exports = { isTerminalResponse, isLocalCommand, acceptShellEvent, SubmissionTracker, PromptMarkers, PROMPT_MARKER, InputGate };
