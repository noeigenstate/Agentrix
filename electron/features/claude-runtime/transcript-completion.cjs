const { messageText, promptText, promptSummary } = require('../../prompt-queue.cjs');
const { isLocalAgentCommand } = require('../../agent-commands.cjs');
const { finished } = require('../completion/status.cjs');

function isClaudeTurnInput(content, record) {
  const prompt = promptText(content, record);
  if (prompt === null || isLocalAgentCommand('claude', prompt)) return false;
  // Match the reading view's single-line ! shell mode, and Claude's recorded shell context.
  // A heading, markup or custom slash command can still be an owner's model turn.
  return !/^![^\r\n]*$/.test(prompt.trim()) && !/^\s*<bash-(?:input|stdout|stderr)>/.test(prompt);
}

// Persistent servers and watchers do not represent work the parent must review.
const SERVICE_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:dev|start|serve|preview|watch)(?:\s|$)/,
  /^vite(?!\s+build(?:\s|$))(?:\s|$)/,
  /^(?:next\s+(?:dev|start)|(?:nuxt|astro|electron-vite)\s+dev|webpack\s+serve|webpack-dev-server|nodemon)(?:\s|$)/,
  /^(?:python(?:3)?\s+-m\s+http\.server|uvicorn|flask\s+run|rails\s+(?:s|server))(?:\s|$)/,
  /^(?:jupyter\s+(?:notebook|lab)|hugo\s+server|jekyll\s+serve)(?:\s|$)/,
  /^node\s+["']?(?:[^\s"']*[\\/])?(?:[\w.-]+-)?(?:preview|(?:dev|preview|static|http)-server|watcher)\.[cm]?js["']?(?:\s|$)/,
  /(?:^|\s)--watch(?:[=\s]|$)/,
  /^tsc\s+(?:\S+\s+)*-w(?:\s|$)/,
  /^tail\s+(?:\S+\s+)*(?:-f|-F|--follow(?:=\S+)?)(?:\s|$)/,
  /^docker\s+compose(?![\s\S]*\s(?:-d|--detach)(?:\s|$))(?:\s+(?!up(?:\s|$))\S+)*\s+up(?:\s|$)/,
];
function isServiceCommand(value) {
  let command = typeof value === 'string' ? value.trim() : '', previous;
  do {
    previous = command;
    command = command.replace(/^cd\s+(?:\/d\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&"'\r\n])+?\s*&&\s*/, '')
      .replace(/^env(?:\s+(?:-i|--ignore-environment|--|(?:-u|--unset)\s+\S+|--unset=\S+))*\s+/, '')
      .replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s'"&;]+)(?:\s*&&\s*|\s+)/, '')
      .replace(/^(?:npx(?:\s+(?:-y|--yes))?|pnpm\s+exec|bunx)\s+/, '');
  } while (command !== previous);
  return SERVICE_COMMANDS.some(pattern => pattern.test(command));
}
const enabled = value => value === true || value === 'true';

function updateTasks(work, record, at, content) {
  for (const block of Array.isArray(content) ? content : []) {
    if (record.type === 'assistant' && !record.isMeta && block.type === 'tool_use') {
      const input = block.input || {};
      // A foreground Bash can also become a background task after its timeout.
      if (['Agent', 'Task', 'Bash', 'TaskOutput', 'TaskStop', 'KillShell'].includes(block.name)) {
        const task = input.task_id || input.shell_id;
        const stopped = ['TaskStop', 'KillShell'].includes(block.name) ? work.finish(task) : null;
        work.calls.set(block.id, { name: block.name, task, stopped, at, description: input.description });
        if (block.name === 'Bash' && isServiceCommand(input.command)) {
          const running = work.finish(block.id);
          work.services.add(block.id);
          if (running) work.services.add(running.id);
        }
        if (enabled(input.run_in_background) && !work.services.has(block.id)) work.start(block.id, at, block.id, input.description);
      }
    } else if (record.type === 'user' && block.type === 'tool_result') {
      const result = record.toolUseResult || {}, call = work.calls.get(block.tool_use_id);
      const id = result.backgroundTaskId || (enabled(result.isAsync) ? result.agentId : null);
      if (work.services.has(block.tool_use_id)) {
        work.finish(block.tool_use_id); work.finish(id);
        if (id) work.services.add(id);
      }
      else if (!block.is_error && id) work.start(block.tool_use_id, call?.at ?? at, id, call?.description);
      else if (call?.name === 'TaskOutput') {
        const task = result.task || {};
        if (finished(task.status)) work.finish(task.task_id || call.task);
      } else if (call?.stopped) {
        if (block.is_error) { const { key, ...task } = call.stopped; work.tasks.set(key, task); }
      } else if (['TaskStop', 'KillShell'].includes(call?.name) && !block.is_error) work.finish(call.task || result.task_id);
      else work.finish(block.tool_use_id);
      work.calls.delete(block.tool_use_id);
    }
  }
}

function done(record, text = messageText(record.type === 'queue-operation' ? record.content : record.attachment?.prompt ?? record.message?.content)) {
  const interrupted = record.type === 'user' && /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/.test(text)
    || record.type === 'assistant' && record.isApiErrorMessage;
  const stop = record.type === 'system' && record.subtype === 'stop_hook_summary';
  const ended = interrupted || stop || record.type === 'assistant' && record.message?.stop_reason === 'end_turn';
  return { interrupted, stop, done: ended };
}

function completion(work, record, at) {
  if ((record.isCompactSummary || record.isVisibleInTranscriptOnly || record.message?.model === '<synthetic>') && !record.isApiErrorMessage) return;
  const content = record.message?.content;
  updateTasks(work, record, at, content);
  const queued = record.type === 'queue-operation';
  if (queued && (record.operation === 'clear' || record.operation === 'popAll' && record.content == null)) work.notifications.clear();
  const text = messageText(queued ? record.content : record.attachment?.prompt ?? content);
  let delivered = false;
  const notices = [];
  for (const [notice] of (queued || ['user', 'attachment'].includes(record.type) ? text : '').matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const tag = name => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(notice)?.[1];
    const taskId = tag('task-id'), toolUseId = tag('tool-use-id'), id = taskId || toolUseId;
    if (!id || !finished(tag('status')) || work.services.has(taskId) || work.services.has(toolUseId)) continue;
    const tracked = work.find(toolUseId) || work.find(taskId);
    const description = work.tasks.get(tracked)?.description;
    const previous = work.deliveries.get(id);
    const text = String(tag('summary') || description || previous?.text || id).replace(/\s+/g, ' ').trim().slice(0, 2000);
    work.deliveries.set(id, { text, delivered: previous?.delivered || false });
    if (work.deliveries.size > 1000) work.deliveries.delete(work.deliveries.keys().next().value);
    work.finish(toolUseId); work.finish(taskId);
    if (queued && record.operation === 'enqueue') {
      // Historical or duplicate receipts may never be delivered. Only an
      // outstanding job creates queued review; actual delivery still starts it below.
      if (tracked) work.notifications.add(id);
    }
    // A dequeue is anonymous and cannot prove which of several messages was
    // selected. Receipt, or a named delivery, starts the parent's review.
    else if (!queued || ['remove', 'popOne', 'popAll'].includes(record.operation)) {
      work.notifications.delete(id);
      if ((!queued || record.operation === 'remove' && !['cleared_on_cancel', 'dropped_by_hook'].includes(record.reason)) && !previous?.delivered) {
        work.deliveries.get(id).delivered = true;
        notices.push({ text, summary: promptSummary(text, { keepFollowUp: true }) || text, at });
        work.reviewAt = Math.max(work.reviewAt, at); delivered = true;
      }
    }
  }
  const humanDelivery = (record.type === 'user' || record.attachment?.type === 'queued_command')
    && isClaudeTurnInput(record.attachment?.prompt ?? content, record.attachment ? { ...record, ...record.attachment } : record);
  const handoff = queued && ['remove', 'dequeue'].includes(record.operation) && isClaudeTurnInput(record.content, record)
    && !['cleared_on_cancel', 'dropped_by_hook'].includes(record.reason);
  if ((humanDelivery || handoff) && at > (work.turn?.updatedAt || 0)) {
    work.reviewAt = Math.max(work.reviewAt, at); delivered = true;
  }
  const { interrupted, stop, done: ended } = done(record, text);
  const working = delivered || !record.isMeta && record.type === 'assistant' && Array.isArray(content) && content.length && !ended;
  if ((ended || working) && at >= (work.turn?.updatedAt || 0)) {
    // A parent round and the project's outstanding background work have different lifetimes.
    // Keep the first delivered source and its clock through tools and mid-turn messages.
    let background = work.turn?.state === 'working' || ended ? work.turn?.background : null;
    if (notices.length) background = background ? { ...background, count: background.count + notices.length } : { ...notices[0], count: notices.length };
    const state = interrupted || stop && work.turn?.state === 'interrupted' ? 'interrupted' : ended ? 'complete' : 'working';
    work.turn = { state, updatedAt: at, turnId: ended ? record.uuid || `stop-${at}` : null, background };
    if (ended) work.end(at);
  }
}

function nativeCompletion(work, message, at) {
  const pending = work.tasks.size, reviewAt = work.reviewAt;
  work.record({ ...message, timestamp: new Date(at).toISOString() }, 'claude');
  if (message.type === 'system' && message.subtype === 'task_started') {
    if (work.services.has(message.tool_use_id)) work.services.add(message.task_id);
    else if (!work.services.has(message.task_id)) work.start(message.tool_use_id || work.find(message.task_id) || `sdk:${message.task_id}`, at, message.task_id);
  }
  if (message.type === 'system' && message.subtype === 'task_notification' && finished(message.status) && !work.services.has(message.task_id) && !work.services.has(message.tool_use_id)) {
    work.finish(message.tool_use_id); work.finish(message.task_id); work.reviewAt = Math.max(work.reviewAt, at);
  }
  if (message.type === 'result') work.end(at);
  else if (pending !== work.tasks.size || reviewAt !== work.reviewAt) work.changed();
}

module.exports = { completion, nativeCompletion, done, isServiceCommand };
