// The prompts a user has sent an agent and it has not finished yet, for the activity overview: the ones it is
// working on, then the ones waiting their turn. Kept in memory only, never written to disk.
//
// A prompt enters when it is submitted in the terminal (queued), is taken up when the agent's own record shows
// the message (working), and leaves when the round that worked on it ends. The record is what counts: typed
// text can differ from what was sent (a line recalled from history, edited with the arrow keys), so a message
// the record shows takes the oldest waiting prompt and replaces its text.
//
// An item keeps the original text for its hover and a sentence computed when it arrives.
// Slash commands, shell mode and memory notes are not prompts.
const NOT_A_PROMPT = /^[/!#]/;
const FOLLOW_UP = /^(继续|接着|继续吧|继续执行|好的?|可以|行|嗯|是的?|对|go on|continue|keep going|ok(ay)?|yes|y|proceed)[。.!！\s]*$/i;
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();

const MACHINE = /^\s*(?:<(?:task-notification|agent-message|teammate[_-]message|subagent[_-](?:message|notification)|system-reminder|local-command-(?:caveat|stdout|stderr)|environment_context|user_instructions|system_instructions|developer_instructions|user-prompt-submit-hook|send_user_message_question_reply|turn_aborted|tool[_-](?:result|response))\b|#\s*AGENTS\.md instructions\b|\[Subagent hand-back\])/i;
const messageText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => typeof block?.text === 'string').map(block => block.text).join('\n') : '';
// Match the complete prompt, not its bounded display/summary. The CLIs expand pasted tags and image marks.
const promptKey = content => {
  const text = messageText(content);
  return clean(text.replace(/<\/?pasted_content\b[^>]*>\n?/g, '').replace(/\[Image #\d+\]\s?/g, '')) || clean(text);
};
const ownMessage = text => /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(text) || text.trimStart().startsWith('This session is being continued from a previous conversation');
const promptCommand = text => /^\s*<command-name>\s*(\/[^<\s]+)\s*<\/command-name>/.exec(text)?.[1] || /^\s*(\/[\w:-]+)(?=\s|$)/.exec(text)?.[1] || '';
const omitPath = text => text.endsWith('.') ? ' .' : ' ';

// Both CLIs use the user role for bookkeeping too. Check provenance before cleaning away its identifying tags.
function promptText(content, record = {}) {
  if (record.isMeta || record.isSidechain || record.isCompactSummary || record.isVisibleInTranscriptOnly || record.queueTranscriptOnly
    || record.promptSource === 'system' || record.origin?.kind && record.origin.kind !== 'human'
    || record.turnOrigin && record.turnOrigin !== 'human' || record.humanTurn === false
    || record.commandMode && record.commandMode !== 'prompt') return null;
  if (Array.isArray(content) && content.some(block => ['tool_result', 'tool_use', 'function_call_output'].includes(block?.type))) return null;
  const text = messageText(content);
  if (MACHINE.test(text) || ownMessage(text)) return null;
  if (text.trim()) return text;
  if (!Array.isArray(content)) return null;
  if (content.some(block => ['image', 'input_image'].includes(block?.type))) return '[Image #1]';
  return content.some(block => ['file', 'input_file'].includes(block?.type)) ? '[File]' : null;
}

function promptSummary(prompt, { spoken = false, maxChars = spoken ? 28 : 60, maxWords = spoken ? 12 : Infinity, keepFollowUp = false } = {}) {
  const original = promptText(prompt);
  if (original === null) return '';
  let text = promptCommand(original) || original
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/<[a-z][\w:.-]*\b[^>]*\/>/gi, ' ')
    .replace(/<([a-z][\w:.-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<pasted_content\b[^>]*>[\s\S]*$/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`[^`\r\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[(?:Image|File|Attachment|Pasted (?:text|Content))[^\]]*\]/gi, ' ')
    .replace(/(?:https?:\/\/|file:\/\/\/)\S+/gi, omitPath)
    .replace(/["'](?:[a-z]:[\\/]|\/|\.{1,2}[\\/])[^"'\r\n]*["']/gi, ' ')
    .replace(/(?:[a-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/]|[\w@.-]+[\\/])[^\s<>"'。！？!?，,；;]+/gi, omitPath)
    .replace(/\b[\w.-]+\.(?:png|jpe?g|gif|webp|svg|bmp|heic|pdf|txt|md|tsx?|jsx?|[cm]js|json|py|go|rs|csv|docx?|xlsx?|zip|log|ya?ml|html?|css|sh|ps1)\b/gi, ' ')
    .replace(/^\s*(?:[-*>#]+|\d+[.)、])\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .trim().split(/\r?\n|(?<=[。！？!?；;])|(?<=\.)(?=\s|$)/u)[0].replace(/\s+/g, ' ').replace(/\s+([。！？.!?])/g, '$1').trim().replace(/^[。！？.!?]+$/, '');
  const phrase = text.replace(/[，,：:、\s。！？!?；;.]+$/u, '');
  if (!keepFollowUp && FOLLOW_UP.test(phrase)) return '';
  if (spoken) text = phrase;
  if (text) {
    if (!/[一-鿿]/.test(text) && Number.isFinite(maxWords)) {
      const words = text.split(' ');
      return words.length > maxWords ? `${words.slice(0, maxWords).join(' ').replace(/[,;:]+$/, '')}…` : text;
    }
    const chars = [...text];
    // Cards count the ellipsis within their limit; spoken names keep the legacy phrase budget.
    return chars.length > maxChars ? `${chars.slice(0, spoken ? maxChars : maxChars - 1).join('').replace(/[，,：:、\s]+$/u, '')}…` : text;
  }
  if (/\[Image|<image\b|!\[|\.(?:png|jpe?g|gif|webp|svg|bmp|heic)\b/i.test(original)) return '（图片）';
  if (/<pasted_content\b|\[Pasted /i.test(original)) return '（粘贴的内容）';
  if (/```|~~~/.test(original)) return '（代码）';
  return '（附件）';
}

function deliverySummary(reply) {
  const block = String(reply || '').split('【交付】')[1]?.split(/\n\s*【[^】]+】/)[0];
  const line = block && /^[ \t]*(?:[-*>#]+[ \t]*)?(?:\*\*)?(?:问题|优化)(?:\*\*)?[：:][ \t]*([^\r\n]+)/m.exec(block);
  return line ? promptSummary(line[1]) : '';
}

class PromptQueue {
  // grace: how long a submission may wait to be taken up when nothing else is running (a line that was
  // an answer to a question, not a prompt, never is).
  constructor(changed = () => {}, { now = Date.now, grace = 20000 } = {}) {
    this.changed = changed; this.now = now; this.grace = grace;
    this.items = []; this.seen = new Set(); this.count = 0; this.timer = null; this.finishedAt = -Infinity;
    this.task = null; this.lastReply = null;
  }
  list() { this.prune(); return this.items.map(({ id, text, summary, state, at }) => ({ id, text, summary, state, at })); }
  reset() { clearTimeout(this.timer); this.timer = null; this.seen.clear(); this.finishedAt = -Infinity; this.lastReply = null; const changed = this.items.length || this.task; this.items = []; this.task = null; if (changed) this.changed(); }
  // Typed in the terminal. While the agent works it waits for its turn; otherwise it should start at once.
  submit(text, working, at = this.now()) {
    const value = promptText(text);
    if (value === null || NOT_A_PROMPT.test(value.trim())) return;
    this.items.push({ id: `p${++this.count}`, text: value, summary: promptSummary(value, { keepFollowUp: true }), state: 'queued', at, expires: working ? Infinity : at + this.grace });
    this.schedule(); this.changed();
  }
  // The agent's record shows a message it received; id makes a record read twice count once.
  // Return its confirmed input time, preserving a submission handled after the record's timestamp.
  start(text, at = this.now(), id = '', localCommand = false) {
    const value = promptText(text);
    if (value === null || (id && this.seen.has(id))) return;
    if (id) { this.seen.add(id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value); }
    // Local slash commands have a readable name but no model round, and cannot take up queued work.
    if (localCommand) {
      if (!this.items.length && at >= (this.task?.at || 0)) {
        const summary = promptSummary(value);
        this.task = { text: value, title: value, summary, requestSummary: summary, at, endedAt: at }; this.lastReply = null; this.changed();
      }
      return;
    }
    const waiting = this.items.filter(item => item.state === 'queued'), key = promptKey(value);
    const item = waiting.find(candidate => promptKey(candidate.text) === key) || waiting[0];
    const inputAt = Math.max(at, item?.at || 0);
    const summary = promptSummary(value);
    if (!this.task || at >= this.task.at) {
      // A bare continuation starts a round but keeps the work named by the preceding request or delivery.
      const requestSummary = summary || this.task?.summary || '', title = summary ? value : this.task?.title || '';
      this.task = { text: title, title, summary: requestSummary, requestSummary, at, endedAt: at <= this.finishedAt ? this.finishedAt : null };
      if (this.lastReply?.at < at) this.lastReply = null;
      if (this.task.endedAt !== null) this.completeTask();
    }
    // A message from a round that has already ended (its record was read after the round's end was reported).
    if (at <= this.finishedAt) { if (item) { this.items.splice(this.items.indexOf(item), 1); this.schedule(); } this.changed(); return inputAt; }
    const itemSummary = summary || promptSummary(value, { keepFollowUp: true });
    if (item) Object.assign(item, { text: value, summary: itemSummary, state: 'working', started: at, expires: Infinity });
    else this.items.push({ id: `p${++this.count}`, text: value, summary: itemSummary, state: 'working', at, started: at, expires: Infinity });
    // Working prompts come first, in the order the agent took them up.
    this.items.sort((a, b) => (a.state === 'working' ? 0 : 1) - (b.state === 'working' ? 0 : 1) || (a.started ?? a.at) - (b.started ?? b.at));
    this.changed();
    return inputAt;
  }
  // Esc can return a queued send to the CLI's input. It is no longer submitted work.
  cancel(text, at = this.now()) {
    const key = promptKey(text);
    const index = this.items.findIndex(item => item.state === 'queued' && item.at <= at + 500 && promptKey(item.text) === key);
    if (index < 0) return;
    this.items.splice(index, 1); this.schedule(); this.changed();
  }
  // A round ended at this time: the prompts it took up are done. A prompt taken up later belongs to the next
  // round. Waiting ones are sent next by the agent, so they get a short while to be taken up.
  finish(at = this.now()) {
    const before = this.items.length;
    this.finishedAt = Math.max(this.finishedAt, at);
    this.items = this.items.filter(item => item.state !== 'working' || item.started > at);
    for (const item of this.items) if (item.state === 'queued') item.expires = Math.min(item.expires, this.now() + this.grace);
    const completed = this.task && this.task.at <= at && this.task.endedAt === null;
    if (completed) { this.task.endedAt = at; this.completeTask(); }
    this.schedule();
    if (this.items.length !== before || completed) this.changed();
  }
  // A final reply can reach the transcript reader after Stop; its timestamp still belongs to the finished round.
  reply(entry) {
    if (entry.at < (this.lastReply?.at || 0) || this.task && (entry.at < this.task.at || this.task.endedAt !== null && entry.at > this.task.endedAt)) return;
    this.lastReply = { at: entry.at, text: entry.original ?? entry.text ?? '' };
    if (this.task && this.task.endedAt !== null) { this.completeTask(); this.changed(); }
  }
  completeTask() {
    const summary = deliverySummary(this.lastReply?.text);
    this.task.summary = summary || this.task.requestSummary;
    this.task.title = summary ? this.lastReply.text : this.task.text;
  }
  prune() {
    const now = this.now(), expired = this.items.filter(item => item.expires <= now);
    this.items = this.items.filter(item => item.expires > now);
    // A state read can reach expiry before the timer; it must release deferred completion too.
    if (expired.length) this.changed(expired);
  }
  schedule() {
    clearTimeout(this.timer); this.timer = null;
    const next = Math.min(...this.items.map(item => item.expires));
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => { this.timer = null; this.prune(); this.schedule(); }, Math.max(50, next - this.now() + 10));
    this.timer.unref?.();
  }
}

module.exports = { PromptQueue, messageText, ownMessage, promptText, promptKey, promptCommand, promptSummary };
