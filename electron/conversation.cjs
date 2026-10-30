const { claudeAction, claudeOwnRecord, codexActions, codexFailed, resolvePath } = require('./agent-actions.cjs');
const { IMAGE_LIMIT } = require('./oversized-record.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PictureThumbnails, dataImage } = require('./features/files/picture-thumbnail.cjs');
const pictureValues = require('./features/files/picture-values.json');
const { messageText, promptText, promptKey, promptCommand } = require('./prompt-queue.cjs');

// The conversation of a terminal's agent, for the reading view: what the user asked, what the agent
// answered (Markdown), and the tools it called in between. It is read from the records each agent already
// writes (Claude Code's transcript, Codex's rollout), the same ones the activity pane follows, so it shows
// exactly what was said, laid out properly, instead of the terminal's character grid.
//
// An entry is { id, at, role: 'user' | 'assistant' | 'tool', text?, tool? }.
const TEXT_LIMIT = 20000;
// Wrappers the agents put around a prompt that are not what the user typed.
const WRAPPERS = /<(system-reminder|environment_context|user_instructions|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
// Claude marks where a pasted image went ("[Image #2]"); the image itself is shown, so the mark goes.
// Only the start of a huge record is cleaned: the wrapper pattern scans to the end for each unclosed tag, and what is
// shown is cut to TEXT_LIMIT anyway.
const CLEAN_LIMIT = 60000;
// Claude Code wraps pasted text in <pasted_content id=…> tags: the text is what was said, the tags are not.
const PASTED = /<\/?pasted_content\b[^>]*>\n?/g;
const clean = text => String(text || '').slice(0, CLEAN_LIMIT).replace(WRAPPERS, '').replace(PASTED, '').replace(/\[Image #\d+\]\s?/g, '').trim();
// Four small pictures at most; unavailable pixels leave a marker in the same position, never a silent omission.
let thumbnails = new PictureThumbnails();
function pictures(parts) {
  const found = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (found.length >= 4) break;
    if (!['image', 'input_image', 'local_image'].includes(part?.type)) continue;
    let src = part.image_url?.url ?? part.image_url ?? part.url;
    if (src?.omitted === true) { found.push(pictureValues.omitted); continue; }
    if (part.source?.type === 'base64') {
      const { data, media_type: mime } = part.source;
      if (data?.omitted === true || typeof data === 'string' && data.length > IMAGE_LIMIT) { found.push(pictureValues.omitted); continue; }
      src = typeof data === 'string' && /^image\/[\w.+-]+$/.test(mime || '') ? `data:${mime};base64,${data}` : null;
    }
    if (dataImage(src)) {
      found.push(thumbnails.data(src));
      continue;
    }
    found.push(thumbnails.file(part.path ?? part.image_path ?? src));
  }
  return found;
}
const withImages = (entry, parts, log) => { const attached = log.pictures ? pictures(parts) : []; return attached.length ? { ...entry, images: attached } : entry; };

// Older Codex events carry pictures beside their text. Normalize them before the prompt provenance check too,
// so a local_image-only user message is a prompt, while system/tool records still fail that check.
function codexUserParts(content, item) {
  const parts = Array.isArray(content) ? [...content] : [{ type: 'text', text: typeof content === 'string' ? content : '' }];
  for (const values of [item.images, item.local_images]) {
    for (const value of Array.isArray(values) ? values.slice(0, 4) : []) {
      if (typeof value === 'string') parts.push(dataImage(value) ? { type: 'input_image', image_url: value } : { type: 'local_image', path: value });
      else if (value?.omitted === true) parts.push({ type: 'input_image', image_url: value });
      else if (value && typeof value === 'object') parts.push({ ...value, type: value.type || (value.path ? 'local_image' : 'input_image') });
    }
  }
  return parts.map(part => part?.type === 'local_image' ? { ...part, type: 'input_image' } : part);
}

const imageTags = /<\/?image\b[^>]*>/gi;
const imagePartsOf = parts => parts.filter(part => ['image', 'input_image'].includes(part?.type)).slice(0, 4);
function pictureSources(preferred, fallback) {
  const first = imagePartsOf(preferred), second = imagePartsOf(fallback);
  return Array.from({ length: Math.min(4, Math.max(first.length, second.length)) }, (_, index) => first[index] || second[index]);
}
function codexUserMessage(log, record, item, id, source) {
  const parts = codexUserParts(item.content ?? item.message, item);
  const textParts = parts.map(part => typeof part?.text === 'string' ? { ...part, text: part.text.replace(imageTags, '') } : part);
  const raw = messageText(textParts).trim(), reply = questionReply(raw);
  const original = reply === null ? promptText(textParts, { ...record, ...record.payload, ...item }) : raw;
  if (original === null) return;
  const text = reply ?? (promptCommand(original) || clean(original));
  const key = promptKey(text), explicitTurn = item.turn_id || record.payload.turn_id || null, turn = explicitTurn || log.codexTurn;
  const imageParts = imagePartsOf(parts);
  if (source === 'response') {
    // Codex also injects image-only user-role records for view_image. Only a canonical user event owns a bubble.
    if (!imageParts.length || !raw && !/<image\b/i.test(messageText(parts))) return;
    if (!log.pictures) return;
    const pending = { key, turn: explicitTurn, parts: imageParts };
    const previous = log.codexUser;
    const shown = previous && log.list.find(entry => entry.id === previous.id);
    if (shown && previous.key === key && (!previous.turn || !turn || previous.turn === turn) && !previous.response) {
      const attached = pictures(pictureSources(imageParts, previous.parts));
      log.put({ ...shown, images: attached }); previous.response = true;
    } else log.codexPictures = pending;
    return;
  }
  const pending = log.codexPictures;
  const matched = pending && pending.key === key && (!pending.turn || !turn || pending.turn === turn);
  const entry = withImages({ id: `u:${id}`, at: Date.parse(record.timestamp) || Date.now(), role: 'user', text: bounded(text), original, ...(reply !== null ? { answer: true } : {}) }, matched ? pictureSources(pending.parts, parts) : parts, log);
  if (matched) log.codexPictures = null;
  log.codexUser = { id: entry.id, key, turn, response: !!matched, parts: log.pictures ? imageParts : [] };
  if (text || entry.images) log.put(entry);
}
// A picture Codex generated (its image_gen tool) and saved under generated_images. The reading view shows a small copy
// made from the saved file (the main process sets how, see setThumbnailer), never the full image inline, and opens
// the file itself on a click.
const GENERATED = /[\\/]generated_images[\\/][^\\/]+[\\/][^\\/]+\.(?:png|jpe?g|webp)$/i;
// Codex records the path on the system it runs on; either form of an absolute path is read the same way everywhere.
const isGeneratedImage = file => typeof file === 'string' && !/^(?:[\\/]{2}|file:)/i.test(file) && (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) && GENERATED.test(file);
// fromFile(path) and fromDataUrl(url) return a small data URL, or null to keep what there is.
function setThumbnailer(fromFile, fromDataUrl = url => url) { thumbnails = new PictureThumbnails(fromFile, fromDataUrl); }
function generatedImage(item, at) {
  const kind = item?.type === 'Extension' ? item.kind : item?.type;
  if (!['image_gen.generation', 'imageGeneration'].includes(kind) || item.status !== 'completed' || !isGeneratedImage(item.savedPath)) return null;
  let src = null;
  src = thumbnails.file(item.savedPath);
  if (!dataImage(src) && typeof item.result === 'string' && item.result.length <= IMAGE_LIMIT) src = thumbnails.data(`data:image/png;base64,${item.result}`);
  if (!dataImage(src)) return null;
  return { id: `g:${item.id}`, at, role: 'assistant', text: '', images: [src], generated: { path: item.savedPath, prompt: bounded(String(item.revisedPrompt || '')) } };
}
const bounded = text => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n…` : text;
// A step as the reading view shows it; an edit names the files it left (not deleted ones), so the documents, pages and
// videos among them can be previewed. Keep their cwd here; the project folder may be a parent of it.
const brief = (action, cwd = action.cwd) => ({ kind: action.kind, tool: action.tool, target: action.target, detail: action.detail, done: action.done, failed: action.failed, phrase: action.phrase, object: action.object,
  ...(action.kind === 'edit' && action.files?.length ? { written: action.files.filter(file => file.change !== 'delete').map(file => cwd ? resolvePath(cwd, file.path.replace(/\\/g, '/')) : file.path).slice(0, 8) } : {}) });

// Entries keep their order; a later record about the same entry (a tool that finished) replaces it.
class ConversationLog {
  // cwd: the folder Codex works in (its session's and each turn's), which relative file paths in its steps start from.
  constructor(changed = () => {}, limit = 400, { pictures = true } = {}) {
    this.pictures = pictures;
    this.changed = changed; this.limit = limit; this.list = []; this.cwd = null;
    this.queue = []; this.received = new Map(); this.deliveries = [];
  }
  // Records still feed activity tracking during replay, but reading snapshots wait for the file tail.
  beginHistory() { this.loading = true; }
  endHistory() { if (!this.loading) return; this.loading = false; this.changed({ reset: true }); }
  snapshot() { return this.loading ? [] : this.list; }
  reset() {
    this.codexUser = null; this.codexPictures = null; this.codexTurn = null;
    this.queue = []; this.received.clear(); this.deliveries = [];
    if (!this.list.length) return;
    this.list = []; this.changed({ reset: true });
  }
  // inOrder: a new entry goes before those stamped after it, and the window gets the whole list again.
  put(entry, inOrder = false) {
    const index = this.list.findIndex(item => item.id === entry.id);
    if (index >= 0) { this.list[index] = entry; this.changed({ entry }); return; }
    let at = this.list.length;
    if (inOrder) while (at > 0 && this.list[at - 1].at > entry.at) at--;
    this.list.splice(at, 0, entry);
    if (this.list.length > this.limit) this.list.shift();
    this.changed(at < this.list.length - 1 ? { reset: true, entry } : { entry });
  }
  // An entry gone (a queued message taken up): the window gets the whole list again.
  drop(id) {
    const index = this.list.findIndex(item => item.id === id);
    if (index < 0) return;
    this.list.splice(index, 1); this.changed({ reset: true });
  }
  // A tool whose result arrived. prefix: a Codex call id covers every step its script made.
  finish(id, failed = false, prefix = false) {
    for (let index = 0; index < this.list.length; index++) {
      const entry = this.list[index];
      if (entry.role !== 'tool' || entry.tool.done || !(prefix ? entry.id.startsWith(`${id}:`) : entry.id === id)) continue;
      const next = { ...entry, tool: { ...entry.tool, done: true, failed } };
      this.list[index] = next; this.changed({ entry: next });
    }
  }
  // A round that ended leaves nothing running.
  settle() {
    for (let index = 0; index < this.list.length; index++) {
      const entry = this.list[index];
      if (entry.role !== 'tool' || entry.tool.done) continue;
      const next = { ...entry, tool: { ...entry.tool, done: true } };
      this.list[index] = next; this.changed({ entry: next });
    }
  }
}

function dropQueued(log, index, cancelled = false) {
  const [entry] = log.queue.splice(index, 1);
  // A hidden receipt stops withdrawn or historical accepted sends from being automatically retried.
  if (cancelled) log.put({ ...entry, cancelled: true });
  else log.drop(entry.id);
}

// Removal and receipt can be written in either order. Keep just the unpaired signal, without retaining pictures.
function noteDelivery(log, { id, original, at, receivedAt, ignored }, received) {
  log.deliveries.push({ id, original, at, receivedAt, ignored, received });
  if (log.deliveries.length > 1000) log.deliveries.shift();
}

// Anonymous dequeues do not identify a message: Claude selects by priority and the history tail may omit earlier
// enqueues. Only a named removal or the actual user/queued_command receipt can retire a particular queued card.
function claudeQueue(log, record, queueOnly) {
  const original = promptText(record.content, record), text = original === null ? '' : clean(original);
  if (record.operation === 'enqueue') {
    // A slash command or shell line sent while it works is not a message (the reading view's isTypedCommand).
    const command = /^\s*<command-name>/.test(original || '') || (/^\/[^\s/]+(?:\s|$)/.test(text) || text.startsWith('!')) && !/[\r\n]/.test(text);
    if (original === null || command) return;
    const id = `q:${record.uuid || createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
    if (log.queue.some(entry => entry.id === id)) return;
    const entry = withImages({ id, at: Date.parse(record.timestamp) || Date.now(), role: 'user', text: bounded(text), original, queued: true }, record.content, log);
    log.queue.push(entry); log.put(entry);
    return;
  }
  if (record.operation === 'clear' || record.operation === 'popAll' && record.content == null) {
    while (log.queue.length) dropQueued(log, 0, true);
    return;
  }
  if (!['remove', 'dequeue', 'popAll', 'popOne'].includes(record.operation)) return;
  if (original === null) {
    receivedPrompt(log, { id: `q:${record.operation}:${record.timestamp}`, at: Date.parse(record.timestamp) || Date.now(), original: messageText(record.content) }, { ignored: true, fromRemoval: true });
    return;
  }
  const cancelled = ['popAll', 'popOne'].includes(record.operation) || ['cleared_on_cancel', 'dropped_by_hook'].includes(record.reason);
  const key = promptKey(original);
  if (!cancelled) {
    const received = log.deliveries.findIndex(entry => entry.received && promptKey(entry.original) === key);
    if (received >= 0) { log.deliveries.splice(received, 1); return; }
  }
  const at = Date.parse(record.timestamp) || Date.now();
  const index = log.queue.findIndex(entry => entry.at <= at && promptKey(entry.original) === key);
  if (index < 0) return;
  if (cancelled) { dropQueued(log, index, true); return; }
  const [entry] = log.queue.splice(index, 1);
  const receipt = { ...entry, receivedAt: Math.max(at, entry.at), queued: false };
  noteDelivery(log, receipt, false);
  // The named handoff is already a receipt, even when Claude never writes a user message afterward.
  // Keep its identity so that a later user record updates it without taking up another queued send.
  // A prefix receipt acknowledges the send without replaying a user turn outside the display window.
  if (queueOnly) log.put({ ...entry, cancelled: true });
  else { log.drop(entry.id); log.put(receipt); }
}

function receivedPrompt(log, entry, { inOrder = false, fromQueue = false, queueOnly = false, ignored = false, fromRemoval = false } = {}) {
  let receipt = log.received.get(entry.id);
  const replay = !!receipt;
  if (!receipt) {
    // A queued receipt may predate enqueue logging. Unrelated old turns still need the timestamp guard.
    const key = promptKey(entry.original);
    const matches = queued => (fromQueue || queued.at <= entry.at + 500) && promptKey(queued.original) === key;
    // Pair the already-promoted handoff first, so a later identical send stays queued.
    const removed = log.deliveries.findIndex(queued => queued.received === fromRemoval && matches(queued));
    const index = removed < 0 ? log.queue.findIndex(matches) : -1;
    const source = removed >= 0 ? log.deliveries.splice(removed, 1)[0] : index >= 0 ? log.queue[index] : entry;
    receipt = { id: source.id, at: source.at, receivedAt: Math.max(entry.receivedAt ?? entry.at, source.receivedAt ?? source.at), paired: removed >= 0 || index >= 0, ignored: source.ignored };
    if (index >= 0) {
      noteDelivery(log, { ...source, receivedAt: receipt.receivedAt, ignored }, !fromRemoval);
      if (ignored) log.queue.splice(index, 1);
      else dropQueued(log, index, queueOnly);
    }
    log.received.set(entry.id, receipt);
    if (log.received.size > 1000) log.received.delete(log.received.keys().next().value);
  }
  entry = { ...entry, id: receipt.id, receivedAt: receipt.receivedAt };
  const previous = log.list.find(item => item.id === receipt.id);
  if (ignored || receipt.ignored) {
    if (!receipt.ignored && (receipt.paired || replay)) {
      log.put({ ...previous, ...entry, at: previous?.at ?? receipt.at, role: 'user', text: previous?.text ?? bounded(clean(entry.original)), queued: true, cancelled: true });
    }
    receipt.ignored = true;
    for (const delivery of log.deliveries) if (delivery.id === receipt.id) delivery.ignored = true;
    return;
  }
  // A workOnly observation consumes once; its later full observation must still publish the same entry.
  if (!queueOnly) { if (previous?.queued) log.drop(entry.id); log.put(entry, inOrder); }
}

function claudeConversation(log, record, cwd, { queueOnly = false } = {}) {
  if (record?.type === 'queue-operation') { if (!record.isSidechain) claudeQueue(log, record, queueOnly); return; }
  if (!record || record.isSidechain) return;
  const queued = record?.type === 'attachment' && record.attachment?.type === 'queued_command' ? record.attachment : null;
  if (queued && !record.isSidechain) {
    const original = promptText(queued.prompt, { ...record, ...queued });
    if (original === null) {
      receivedPrompt(log, { id: `u:${record.uuid || record.timestamp}`, at: Date.parse(record.timestamp) || Date.now(), original: messageText(queued.prompt) }, { ignored: true });
      return;
    }
    const text = promptCommand(original) || clean(original);
    const entry = withImages({ id: `u:${record.uuid || record.timestamp}`, at: Date.parse(record.timestamp) || Date.now(), role: 'user', text: bounded(text), original }, queued.prompt, log);
    if (text || entry.images) receivedPrompt(log, entry, { fromQueue: true, queueOnly });
    return;
  }
  if (!record.message || record.isMeta && record.type !== 'user') return;
  const content = record.message.content, at = Date.parse(record.timestamp) || Date.now(), base = String(record.uuid || at);
  if (record.type === 'user') {
    if (Array.isArray(content) && content.some(block => block.type === 'tool_result')) {
      if (record.isMeta || claudeOwnRecord(record)) return;
      for (const block of content) if (block.type === 'tool_result') log.finish(String(block.tool_use_id || ''), block.is_error === true);
      return;
    }
    const original = promptText(content, record);
    if (original === null) {
      receivedPrompt(log, { id: `u:${base}`, at, original: messageText(content) }, { ignored: true });
      return;
    }
    const text = promptCommand(original) || clean(original);
    const entry = withImages({ id: `u:${base}`, at, role: 'user', text: bounded(text), original }, content, log);
    // A conversation's first prompt, which Claude Code writes after the reply to it, goes before that reply.
    if (text || entry.images) receivedPrompt(log, entry, { inOrder: record.parentUuid === null, fromQueue: record.promptSource === 'queued', queueOnly });
    return;
  }
  if (claudeOwnRecord(record) || record.type !== 'assistant' || !Array.isArray(content)) return;
  const original = messageText(content);
  content.forEach((block, index) => {
    const text = block.type === 'text' ? clean(block.text) : '';
    if (text) log.put({ id: `a:${base}:${index}`, at, role: 'assistant', text: bounded(text), original });
    else if (block.type === 'tool_use') { const action = claudeAction(block, at, record.cwd || cwd); log.put({ id: action.id, at, role: 'tool', tool: brief(action, record.cwd || cwd) }); }
  });
}

// Codex records the answers to its own questions (request_user_input) as a user message: the questions and the chosen
// answers as JSON inside <send_user_message_question_reply>. They answer it; they are not something the user asked.
// Gives the readable "question → answer" lines, '' for a reply that cannot be read, or null for any other message.
const QUESTION_REPLY = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/;
function questionReply(text) {
  const match = QUESTION_REPLY.exec(String(text || ''));
  if (!match) return null;
  let answers; try { answers = JSON.parse(match[1]); } catch { return ''; }
  if (!Array.isArray(answers)) return '';
  const said = value => typeof value === 'string' && value.trim() ? value.trim() : '';
  return answers.map(item => [said(item?.question), said(item?.answer)]).filter(([question, answer]) => question || answer)
    .map(([question, answer]) => question && answer ? `${question}\n→ ${answer}` : question || `→ ${answer}`).join('\n\n');
}
// Newer Codex reports each message once as a completed item; older versions as event messages.
function codexConversation(log, record, cwd) {
  if (!record?.payload) return;
  const payload = record.payload, at = Date.parse(record.timestamp) || Date.now();
  if (record.type === 'session_meta') { log.reset(); log.cwd = payload.cwd || cwd; return; }
  if (record.type === 'turn_context') {
    log.cwd = payload.cwd || log.cwd;
    const turn = payload.turn_id || payload.id || null;
    if (turn && log.codexTurn && turn !== log.codexTurn) log.codexUser = null;
    if (turn && log.codexPictures) {
      if (log.codexPictures.turn && log.codexPictures.turn !== turn) log.codexPictures = null;
      else log.codexPictures.turn = turn;
    }
    if (turn) log.codexTurn = turn;
    return;
  }
  if (record.type === 'event_msg') {
    const picture = log.pictures && payload.type === 'item_completed' ? generatedImage(payload.item, at) : null;
    if (picture) log.put(picture);
    else if (payload.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(payload.item?.type)) {
      if (payload.item.type === 'UserMessage') { codexUserMessage(log, record, payload.item, payload.item.id || at, 'item'); return; }
      const original = messageText(payload.item.content), text = clean(original);
      if (text) log.put({ id: `a:${payload.item.id || at}`, at, role: 'assistant', text: bounded(text), original });
    } else if (['user_message', 'agent_message'].includes(payload.type) && (typeof payload.message === 'string' || Array.isArray(payload.message) || payload.type === 'user_message' && (payload.images?.length || payload.local_images?.length))) {
      const original = messageText(payload.message), id = `${at}:${original.length}`;
      if (payload.type === 'user_message') { codexUserMessage(log, record, payload, id, 'event'); return; }
      const text = clean(original);
      if (text) log.put({ id: `a:${id}`, at, role: 'assistant', text: bounded(text), original });
    } else if (['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(payload.type)) { log.codexUser = null; log.codexPictures = null; log.settle(); }
    return;
  }
  if (record.type !== 'response_item') return;
  if (payload.type === 'message' && payload.role === 'user') {
    codexUserMessage(log, record, payload, payload.id || `${at}:${messageText(payload.content).length}`, 'response');
    return;
  }
  if (['custom_tool_call_output', 'function_call_output', 'local_shell_call_output'].includes(payload.type)) { log.finish(String(payload.call_id || ''), codexFailed(payload), true); return; }
  for (const action of codexActions(payload, at, log.cwd || cwd)) log.put({ id: action.id, at, role: 'tool', tool: brief(action) });
}

module.exports = { ConversationLog, claudeConversation, codexConversation, clean, brief, generatedImage, isGeneratedImage, setThumbnailer, questionReply };
