const { messageText, promptText } = require('./prompt-queue.cjs');

// Jobs with missing end receipts expire from launch, without success; services are excluded.
const LOST_WORK_TIMEOUT = 12 * 60 * 60 * 1000;
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
const finished = status => typeof status === 'object' && status !== null ? Object.keys(status).some(finished)
  : /^(?:completed|complete|failed|killed|stopped|shutdown|errored|idle|not_found)$/.test(status || '');
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };

class CompletionWork {
  constructor({ now = Date.now, changed = () => {}, timeout = LOST_WORK_TIMEOUT } = {}) {
    this.now = now; this.changed = changed; this.timeout = timeout; this.reset();
  }
  reset() {
    const pending = !!(this.tasks?.size || this.notifications?.size || this.reviewAt || this.reading);
    clearTimeout(this.timer); this.timer = null;
    this.tasks = new Map(); this.calls = new Map(); this.services = new Set(); this.notifications = new Set();
    this.reviewAt = 0; this.endedAt = 0; this.turn = null; this.reading = false;
    this.expired = false; this.version = 0;
    this.uncertain = false;
    return pending;
  }
  begin(at) {
    this.expired = false;
    if (at > this.endedAt) this.reviewAt = Math.max(this.reviewAt, at);
  }
  find(id) {
    if (typeof id !== 'string') return undefined;
    for (const [key, task] of this.tasks) {
      if (key === id || task.id === id || task.id?.endsWith(`/${id}`) || id.endsWith(`/${task.id}`)) return key;
    }
  }
  start(key, at, id = key) {
    if (key) this.tasks.set(key, { id, startedAt: this.tasks.get(key)?.startedAt ?? at });
  }
  finish(id) {
    const key = this.find(id), task = this.tasks.get(key);
    if (key) this.tasks.delete(key);
    return task && { key, ...task };
  }
  end(at) {
    this.endedAt = Math.max(this.endedAt, at);
    if (at >= this.reviewAt) this.reviewAt = 0;
  }
  record(record, agent, clockOffset = 0) {
    if (!record || record.isSidechain || record.type === 'api-request-blob') return;
    const timestamp = Date.parse(record.timestamp), at = Number.isFinite(timestamp) ? timestamp + clockOffset : this.now();
    if (agent === 'claude') this.claude(record, at);
    else this.codex(record, at);
    this.version++;
  }
  claude(record, at) {
    const content = record.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && block.type === 'tool_use') {
        const input = block.input || {};
        // A foreground Bash can also become a background task after its timeout.
        if (['Agent', 'Task', 'Bash', 'TaskOutput', 'TaskStop', 'KillShell'].includes(block.name)) {
          const task = input.task_id || input.shell_id;
          const stopped = ['TaskStop', 'KillShell'].includes(block.name) ? this.finish(task) : null;
          this.calls.set(block.id, { name: block.name, task, stopped, at });
          if (block.name === 'Bash' && isServiceCommand(input.command)) {
            const running = this.finish(block.id);
            this.services.add(block.id);
            if (running) this.services.add(running.id);
          }
          if (enabled(input.run_in_background) && !this.services.has(block.id)) this.start(block.id, at);
        }
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const result = record.toolUseResult || {}, call = this.calls.get(block.tool_use_id);
        const id = result.backgroundTaskId || (enabled(result.isAsync) ? result.agentId : null);
        if (this.services.has(block.tool_use_id)) {
          this.finish(block.tool_use_id); this.finish(id);
          if (id) this.services.add(id);
        }
        else if (!block.is_error && id) this.start(block.tool_use_id, call?.at ?? at, id);
        else if (call?.name === 'TaskOutput') {
          const task = result.task || {};
          if (finished(task.status)) this.finish(task.task_id || call.task);
        } else if (call?.stopped) {
          if (block.is_error) this.tasks.set(call.stopped.key, { id: call.stopped.id, startedAt: call.stopped.startedAt });
        } else if (['TaskStop', 'KillShell'].includes(call?.name) && !block.is_error) this.finish(call.task || result.task_id);
        else this.finish(block.tool_use_id);
        this.calls.delete(block.tool_use_id);
      }
    }
    const queued = record.type === 'queue-operation';
    if (queued && (record.operation === 'clear' || record.operation === 'popAll' && record.content == null)) this.notifications.clear();
    const text = messageText(queued ? record.content : record.attachment?.prompt ?? content);
    let delivered = false;
    for (const [notice] of (queued || ['user', 'attachment'].includes(record.type) ? text : '').matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
      const tag = name => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(notice)?.[1];
      const taskId = tag('task-id'), toolUseId = tag('tool-use-id'), id = taskId || toolUseId;
      if (!id || !finished(tag('status')) || this.services.has(taskId) || this.services.has(toolUseId)) continue;
      this.finish(toolUseId); this.finish(taskId);
      if (queued && record.operation === 'enqueue') this.notifications.add(id);
      // A dequeue is anonymous and cannot prove which of several messages was
      // selected. Receipt, or a named delivery, starts the parent's review.
      else if (!queued || ['remove', 'popOne', 'popAll'].includes(record.operation)) {
        this.notifications.delete(id);
        if (!queued || record.operation === 'remove' && !['cleared_on_cancel', 'dropped_by_hook'].includes(record.reason)) {
          this.reviewAt = Math.max(this.reviewAt, at); delivered = true;
        }
      }
    }
    const prompt = promptText(record.attachment?.prompt ?? content, record);
    const humanDelivery = (record.type === 'user' || record.attachment?.type === 'queued_command') && prompt !== null && !/^\s*[\/!#<]/.test(prompt);
    const handoff = queued && ['remove', 'dequeue'].includes(record.operation) && promptText(record.content, record) !== null
      && !['cleared_on_cancel', 'dropped_by_hook'].includes(record.reason);
    if ((humanDelivery || handoff) && at > (this.turn?.updatedAt || 0)) {
      this.reviewAt = Math.max(this.reviewAt, at); delivered = true;
    }
    const ended = record.type === 'assistant' && record.message?.stop_reason === 'end_turn'
      || record.type === 'system' && record.subtype === 'stop_hook_summary';
    const working = delivered || record.type === 'assistant' && Array.isArray(content) && content.length && !ended;
    if ((ended || working) && at >= (this.turn?.updatedAt || 0)) {
      this.turn = { state: ended ? 'complete' : 'working', updatedAt: at, turnId: ended ? record.uuid || `stop-${at}` : null };
      if (ended) this.end(at);
    }
  }
  codex(record, at) {
    const item = record.payload || {};
    if (record.type === 'event_msg') {
      if (['task_complete', 'turn_completed', 'turn_aborted', 'turn_interrupted'].includes(item.type)) this.end(at);
      return;
    }
    if (record.type !== 'response_item') return;
    if (item.type === 'agent_message') {
      const text = messageText(item.content);
      if (/^Message Type: FINAL_ANSWER\s*$/m.test(text)) {
        this.finish(item.author || /^Sender:\s*(\S+)/m.exec(text)?.[1]);
        this.reviewAt = Math.max(this.reviewAt, at);
      }
      return;
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const args = json(item.arguments) || {}, name = (item.name || '').split('.').at(-1);
      // Shells and yielded code cells cannot wake an ended Codex parent; only child agents count.
      if (!['spawn_agent', 'followup_task', 'send_input', 'close_agent', 'interrupt_agent', 'list_agents', 'wait'].includes(name)) return;
      this.calls.set(item.call_id, { name, args, at });
      if (name === 'spawn_agent') this.start(item.call_id, at);
      if (name === 'followup_task' || name === 'send_input') {
        const id = args.target || args.id;
        this.start(this.find(id) || id, at, id);
      }
      return;
    }
    if (!['function_call_output', 'custom_tool_call_output'].includes(item.type)) return;
    const call = this.calls.get(item.call_id);
    if (!call) return;
    this.calls.delete(item.call_id);
    const text = typeof item.output === 'string' ? item.output : messageText(item.output);
    const output = json(text) || json(item.output);
    if (call.name === 'spawn_agent') {
      this.finish(item.call_id);
      const id = output?.agent_id || output?.task_name;
      if (id) this.start(id, call.at);
    }
    if (call.name === 'close_agent') this.finish(call.args.id);
    if (call.name === 'interrupt_agent') this.finish(call.args.target);
    if (call.name === 'list_agents') for (const entry of output?.agents || []) {
      if (finished(entry.agent_status)) this.finish(entry.agent_name);
    }
    if (call.name === 'wait' && output?.status) for (const [id, status] of Object.entries(output.status)) {
      if (finished(status)) this.finish(id);
    }
  }
  native(message, agent, at, parentThreadId) {
    const pending = this.tasks.size, reviewAt = this.reviewAt;
    if (agent === 'claude') {
      this.record({ ...message, timestamp: new Date(at).toISOString() }, agent);
      if (message.type === 'system' && message.subtype === 'task_started') {
        if (this.services.has(message.tool_use_id)) this.services.add(message.task_id);
        else if (!this.services.has(message.task_id)) this.start(message.tool_use_id || this.find(message.task_id) || `sdk:${message.task_id}`, at, message.task_id);
      }
      if (message.type === 'system' && message.subtype === 'task_notification' && finished(message.status) && !this.services.has(message.task_id) && !this.services.has(message.tool_use_id)) {
        this.finish(message.tool_use_id); this.finish(message.task_id); this.reviewAt = Math.max(this.reviewAt, at);
      }
      if (message.type === 'result') this.end(at);
      else if (pending !== this.tasks.size || reviewAt !== this.reviewAt) this.changed();
      return;
    }
    const threadId = message.params?.threadId;
    if (parentThreadId && threadId && threadId !== parentThreadId) {
      if (message.method === 'turn/started') this.start(threadId, at);
      if (['turn/completed', 'turn/interrupted'].includes(message.method)) {
        if (this.finish(threadId)) this.reviewAt = Math.max(this.reviewAt, at);
      }
      if (pending !== this.tasks.size || reviewAt !== this.reviewAt) this.changed();
      return;
    }
    const item = message.params?.item;
    // Native commands, like legacy shells, cannot resume the parent after its turn ends.
    if (item?.type === 'collabAgentToolCall' && ['item/started', 'item/completed'].includes(message.method)) {
      const ended = message.method === 'item/completed';
      const key = `native:${item.id}`, startsWork = ['spawnAgent', 'sendInput', 'resumeAgent'].includes(item.tool);
      if (!ended && startsWork) this.start(key, at);
      if (ended) this.finish(key);
      for (const id of item.receiverThreadIds || []) {
        const status = item.agentsStates?.[id]?.status;
        if (item.tool === 'closeAgent' || finished(status)) {
          if (this.finish(id)) this.reviewAt = Math.max(this.reviewAt, at);
        } else if (startsWork) this.start(id, at);
      }
    }
    if (['turn/completed', 'turn/interrupted'].includes(message.method)) this.end(at);
    this.version++;
    if (pending !== this.tasks.size || reviewAt !== this.reviewAt) this.changed();
  }
  state(snapshot, { queued = false } = {}) {
    const pending = this.tasks.size || this.notifications.size || this.reviewAt || this.reading || queued;
    if (this.uncertain) this.expired = true;
    clearTimeout(this.timer); this.timer = null;
    if (this.tasks.size && ['complete', 'interrupted'].includes(snapshot.state) && !this.expired) {
      const deadline = Math.min(...[...this.tasks.values()].map(task => task.startedAt + this.timeout));
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        for (const [key, task] of this.tasks) if (task.startedAt + this.timeout <= this.now()) {
          this.tasks.delete(key);
        }
        this.expired = true;
      } else {
        this.timer = setTimeout(() => { this.timer = null; this.changed(); }, remaining);
        this.timer.unref?.();
      }
    }
    if (this.expired) return 'interrupted';
    return pending && ['complete', 'interrupted'].includes(snapshot.state) ? 'working' : snapshot.state;
  }
}

module.exports = { CompletionWork, LOST_WORK_TIMEOUT, isServiceCommand };
