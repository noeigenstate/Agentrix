const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { claudePrompt, resolvePath, TranscriptTail } = require('../../agent-actions.cjs');
const { rolloutFiles, sessionMeta } = require('../../session-files.cjs');
const { codexMetadata } = require('../../transcript-window.cjs');
const { TokenRates, emptyRate } = require('./token-rate.cjs');

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const unquote = value => value.replace(/["']/g, '');
const basename = value => value.split(/[\\/]/).at(-1);
const agentRoles = new Map(Object.entries({ Explore: '搜索', Plan: '规划', 'general-purpose': '通用', claude: '通用', none: '通用', fork: '分身' }));

// Heredocs are data: their quotes and command examples must never become shell tokens.
function shellTokens(command) {
  const tokens = [], heredocs = [];
  const syntax = /<<<|<<(-?)[ \t]*((?:[^\s"';&|<>]+|"[^"\r\n]*"|'[^'\r\n]*')+)|#[^\r\n]*|\d?>&\d|&>>?|\d?>>?|<|(?:[^\s"';&|<>]+|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|\n]/g;
  let match;
  while ((match = syntax.exec(command))) {
    if (match[2] !== undefined) {
      heredocs.push({ delimiter: unquote(match[2]), stripTabs: !!match[1] });
      continue;
    }
    const token = match[0];
    if (token.startsWith('#')) continue;
    tokens.push(token);
    if (token !== '\n') continue;
    for (const { delimiter, stripTabs } of heredocs) {
      while (syntax.lastIndex < command.length) {
        const end = command.indexOf('\n', syntax.lastIndex);
        const line = command.slice(syntax.lastIndex, end < 0 ? command.length : end).replace(/\r$/, '');
        syntax.lastIndex = end < 0 ? command.length : end + 1;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
      }
    }
    heredocs.length = 0;
  }
  return tokens;
}

// Only inspect the command, never evaluate shell syntax. Keep quoted config values together.
function codexCall(command, cwd) {
  const tokens = shellTokens(text(command));
  const words = tokens.map(unquote);
  const separator = word => /^(?:&&|\|\||[;&|\n])$/.test(word);
  const start = words.findIndex((word, i) => {
    if (!/(?:^|[\\/])codex(?:\.exe|\.cmd)?$/i.test(word) || words[i + 1] !== 'exec') return false;
    const boundary = tokens.slice(0, i).findLastIndex(separator);
    return words.slice(boundary + 1, i).every(prefix => /^(?:env|nohup|exec)$|^\w+=/.test(prefix));
  });
  if (start < 0) return null;
  const variables = new Map(cwd ? [['PWD', cwd]] : []);
  const expand = value => value.replace(/\$(?:\{(\w+)\}|(\w+))/g, (match, braced, bare) => variables.get(braced || bare) ?? match);
  for (let i = 0; i < start; i++) {
    const assignment = /^(\w+)=(.*)$/.exec(words[i]);
    if (assignment && (!i || separator(words[i - 1]) || /^(?:env|\w+=)/.test(words[i - 1]))) variables.set(assignment[1], expand(assignment[2]));
  }
  let model = 'default', effort = null, fast = null, provider = 'openai', task = '', log = null, prompt = null;
  for (let i = start + 2; i < words.length; i++) {
    const word = words[i];
    if (separator(tokens[i])) break;
    if (word === '-m' || word === '--model') model = words[++i] || model;
    else if (/^(?:-m|--model)=/.test(word)) model = word.slice(word.indexOf('=') + 1) || model;
    else if (word === '-c' || word === '--config' || /^(?:-c|--config)=/.test(word)) {
      const config = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i] || '';
      const match = /^(model|model_provider|model_reasoning_effort|service_tier)=(.+)$/.exec(config);
      if (!match) continue;
      if (match[1] === 'model') model = match[2];
      if (match[1] === 'model_provider') provider = match[2];
      if (match[1] === 'model_reasoning_effort') effort = match[2];
      if (match[1] === 'service_tier') fast = /fast|priority/i.test(match[2]);
    } else if (/^(?:<|[12]?>>?|&>>?)$/.test(tokens[i]) && words[i + 1]) {
      const input = tokens[i] === '<';
      let filename = tokens[++i].startsWith("'") ? words[i] : expand(words[i]);
      // Git Bash records drive aliases; only a Windows cwd proves they name local files.
      if (process.platform === 'win32' && /^(?:[a-z]:[\\/]|\\\\)/i.test(cwd || '')) filename = filename.replace(/^\/([a-z])\//i, '$1:/');
      const resolved = /[$`]|^(?:nul|\/dev\/null)$/i.test(filename) ? null : resolvePath(cwd, filename);
      if (input) { task = basename(filename); prompt = resolved; } else log = resolved;
    }
  }
  return { model, effort, fast, provider, task, log, prompt };
}

// Brief headings need only the beginning; retry missing or empty files until their writer runs.
async function readPrompt(filename) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const buffer = Buffer.alloc(Math.min((await file.stat()).size, 4096));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; } finally { await file?.close(); }
}

class AgentCalls {
  constructor({ changed = () => {}, names = id => id === 'openai' ? 'OpenAI' : id, local = true, codexHome } = {}) {
    this.changed = changed; this.names = names; this.local = local; this.folder = null;
    this.directory = path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    this.reset();
  }
  reset() { clearTimeout(this.timer); this.timer = null; this.calls = new Map(); this.polls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null; }
  setFolder(folder) { if (folder !== this.folder) { this.reset(); this.folder = folder; } }
  snapshot(provider) {
    const groups = new Map();
    for (const call of this.calls.values()) {
      if (call.reviewed) continue;
      const route = { agent: call.agent, provider: call.agent === 'Claude Code' ? provider ?? null : this.names(call.provider), model: call.model, effort: call.effort, fast: call.fast };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, preparing: 0, running: 0, reviewing: 0, tasks: [], items: [], rate: emptyRate(false) });
      const group = groups.get(key);
      if (!call.rate) group.rate = null;
      else if (group.rate) {
        group.rate.outputTokens += call.rate.outputTokens; group.rate.activeMs += call.rate.activeMs; group.rate.samples += call.rate.samples;
        group.rate.updatedAt = Math.max(group.rate.updatedAt, call.rate.updatedAt); group.rate.partial ||= call.rate.partial;
      }
      const state = call.done ? 'reviewing' : call.preparing ? 'preparing' : 'running';
      group[state]++;
      group.items.push({ state, role: call.role, title: call.title });
      if (call.task) { group.tasks = group.tasks.filter(task => task !== call.task); group.tasks.push(call.task); group.tasks = group.tasks.slice(-5); }
    }
    for (const group of groups.values()) group.items.reverse();
    return [...groups.values()];
  }
  apply(record) {
    if (record.isSidechain) return false;
    const content = record.message?.content;
    const at = Date.parse(record.timestamp);
    let changed = false;
    for (const block of Array.isArray(content) ? content : []) {
      if (record.type === 'assistant' && block.type === 'tool_use' && ['BashOutput', 'TaskOutput', 'TaskStop', 'KillShell'].includes(block.name)) {
        const task = block.input?.bash_id || block.input?.task_id || block.input?.shell_id;
        if (typeof block.id === 'string' && typeof task === 'string' && task) this.polls.set(block.id, { task, stop: ['TaskStop', 'KillShell'].includes(block.name) });
        continue;
      }
      if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && !this.calls.has(block.id)) {
        const input = block.input || {}, codex = block.name === 'Bash' ? codexCall(input.command, record.cwd) : null;
        if (block.name !== 'Agent' && !codex) continue;
        const model = codex?.model || text(input.model) || 'default';
        this.calls.set(block.id, {
          agent: codex ? 'Codex' : 'Claude Code', provider: codex?.provider ?? null,
          model, requestedModel: model, rate: null,
          effort: codex?.effort ?? null, fast: codex?.fast ?? null,
          task: short(input.description || block.description || codex?.task || input.subagent_type || block.name),
          title: text(codex?.task || input.description || block.description || input.subagent_type || block.name).replace(/\s+/g, ' ').trim(),
          role: codex ? '执行' : agentRoles.get(input.subagent_type) || text(input.subagent_type) || '通用',
          prompt: this.local && this.folder ? codex?.prompt : null,
          background: enabled(input.run_in_background), done: false, preparing: this.local && (codex ? !!codex.log : !!this.folder), log: codex?.log,
        });
        this.refresh(block.id);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const result = record.toolUseResult || {}, poll = this.polls.get(block.tool_use_id);
        if (poll) {
          this.polls.delete(block.tool_use_id);
          const task = result.task?.task_id || result.task_id || poll.task;
          const call = [...this.calls.values()].find(call => call.backgroundTaskId === task || (poll.stop && call.agentId === task));
          if (call && !call.reviewed && (!call.done || call.pendingReview) && !block.is_error && (poll.stop || /^(?:completed|failed|killed)$/.test(result.task?.status || result.status))) {
            call.done = true; call.finishedAt = at; call.pendingReview = false; changed = true;
          }
          continue;
        }
        const call = this.calls.get(block.tool_use_id);
        if (!call || call.reviewed) continue;
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (call.agent === 'Codex' && typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if ((block.is_error || !call.background) && !call.done) { call.done = true; call.finishedAt = at; changed = true; }
        if (call.agent === 'Claude Code') {
          if (typeof result.resolvedModel === 'string' && result.resolvedModel) {
            call.resultModel = result.resolvedModel;
            const model = call.meter?.model || result.resolvedModel;
            changed ||= call.model !== model; call.model = model;
          }
          if (typeof result.agentId === 'string' && /^[\w-]+$/.test(result.agentId)) call.agentId = result.agentId;
          this.refresh(block.tool_use_id);
        }
      }
    }
    // An enqueue ends the worker; its delivered notification starts the lead's review round.
    let hasNotification = false;
    const queued = record.type === 'queue-operation';
    if (record.type === 'user' || (queued && ['enqueue', 'remove'].includes(record.operation)) || record.attachment?.type === 'queued_command') {
      const notificationContent = queued ? text(record.content) : record.attachment?.prompt ?? content;
      const body = typeof notificationContent === 'string' ? notificationContent : (Array.isArray(notificationContent) ? notificationContent.filter(block => block.type === 'text').map(block => text(block.text)).join('\n') : '');
      for (const [notification] of body.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
        hasNotification = true;
        let id = /<tool-use-id>\s*([^<]+?)\s*<\/tool-use-id>/.exec(notification)?.[1];
        const taskId = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(notification)?.[1];
        if (!/<status>\s*(?:completed|failed|killed)\s*<\/status>/.test(notification)) continue;
        if (!this.calls.has(id) && taskId) id = [...this.calls].find(([, call]) => call.backgroundTaskId === taskId || call.agentId === taskId)?.[0];
        const call = this.calls.get(id);
        if (!call || call.reviewed) continue;
        if (queued && record.operation === 'remove' && !call.done) continue;
        if (!call.done) {
          call.done = true; call.finishedAt = at; call.pendingReview = queued; changed = true;
        }
        if (call.pendingReview && (!queued || record.operation === 'remove')) { call.pendingReview = false; call.finishedAt = at; }
      }
    }
    // The app completes Claude rounds on Stop. Use that hook's transcript record, not assistant text or idle time.
    const prompt = claudePrompt(record) && !hasNotification;
    if (prompt || (record.type === 'system' && record.subtype === 'stop_hook_summary')) {
      for (const call of this.calls.values()) {
        if (!call.done || call.reviewed || call.finishedAt > at || (call.pendingReview && !prompt)) continue;
        call.reviewed = true; changed = true;
      }
    }
    for (const [id, call] of this.calls) if (call.done && !call.drained) this.refresh(id);
    this.schedule();
    return changed;
  }
  follows(call) {
    return this.local && (this.folder || call.log) && (call.done ? !call.drained : !call.reviewed &&
      (call.agent === 'Claude Code' ? !!this.folder : !!call.prompt || !!call.log && (call.preparing || call.threadId || !call.headerDone)));
  }
  // Follow running workers too; generation identity cancels even an already queued callback.
  schedule() {
    const active = [...this.calls.values()].filter(call => this.follows(call));
    if (!active.length) { clearTimeout(this.timer); this.timer = null; return; }
    if (this.timer || this.work) return;
    const calls = this.calls;
    this.timer = setTimeout(() => {
      if (this.calls !== calls) return;
      this.timer = null;
      for (const [id, call] of calls) if (this.follows(call)) this.refresh(id);
    }, active.some(call => !call.preparing) ? 1000 : 2500);
    this.timer.unref();
  }
  // Batch related history records; bound workers retain offsets and partial lines.
  refresh(id) {
    if (!this.local || !this.folder && !this.calls.get(id)?.log) return;
    clearTimeout(this.timer); this.timer = null;
    this.pending.add(id);
    if (this.work) return;
    const calls = this.calls, pending = this.pending, folder = this.folder;
    this.work = Promise.resolve().then(async () => {
      while (pending.size && this.calls === calls) {
        const ids = new Set(pending); pending.clear();
        const before = new Map([...ids].map(id => [id, this.signature(calls.get(id))]));
        await this.readModels(folder, ids, calls);
        if (this.calls !== calls) return;
        for (const id of ids) {
          const call = calls.get(id);
          if (!call) continue;
          const prompt = call.prompt ? await readPrompt(call.prompt) : null;
          if (this.calls !== calls) return;
          if (prompt) {
            call.prompt = null;
            const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(prompt.replace(/^\uFEFF/, ''))?.[1];
            const title = heading?.replace(/^Task\s+[\w-]+(?:\s*\([^)]*\))?\s*[:：]\s*/i, '').trim() || call.title;
            // File-specific read-only restrictions also appear in implementation briefs.
            const role = /\bread[- ]only\b|只读/i.test(heading || '') ||
              /^[ \t]*(?:[-*][ \t]+)?(?:this (?:task|run) is )?(?:read[- ]only\b|只读)/im.test(prompt.split(/\r?\n/, 20).join('\n')) ? '调查' : '执行';
            call.title = title; call.role = role;
          }
          if (call.agent === 'Codex') await this.readExec(call, calls);
          if (this.calls !== calls) return;
          if (call.done && (!call.rate || call.reader.offset >= call.reader.fileSize)) call.drained = true;
        }
        if ([...ids].some(id => !calls.get(id)?.reviewed && before.get(id) !== this.signature(calls.get(id)))) this.changed();
      }
    }).catch(() => {}).finally(() => { if (this.calls === calls) { this.work = null; this.schedule(); } });
  }
  signature(call) { return JSON.stringify(call && [call.model, call.preparing, call.title, call.role, call.rate]); }
  bind(call, filename) {
    if (call.reader?.filename === filename) return;
    call.model = call.resultModel || call.requestedModel; call.rate = null; call.verified = false;
    call.meter = new TokenRates(call.agent === 'Codex' ? 'codex' : 'claude', { sidechain: true });
    call.reader = filename ? new TranscriptTail(filename, { onReset: async (partial, file) => {
      call.meter.reset(partial);
      call.verified = call.agent === 'Claude Code' || !!await codexMetadata(file, call.threadId, 'exec');
    } }) : null;
  }
  async readWorker(call, filename, calls, meta = null) {
    this.bind(call, filename);
    if (!call.reader) { call.model = call.resultModel || text(meta?.model) || call.requestedModel; return; }
    const readable = await call.reader.read(record => {
      if (this.calls !== calls || !call.verified) return;
      if (call.agent === 'Codex' && record.type === 'session_meta' && (record.payload?.id !== call.threadId || record.payload?.source !== 'exec')) { call.verified = false; return; }
      call.meter.apply(record);
      if (record.type === 'assistant' || record.type === 'token_usage_record') call.preparing = false;
    }).catch(() => false);
    if (this.calls !== calls) return;
    call.rate = readable && call.verified ? call.meter.snapshot() : null;
    call.model = call.meter.model || call.resultModel || text(meta?.model) || call.requestedModel;
  }
  async readModels(folder, ids, calls) {
    ids = new Set([...ids].filter(id => calls.get(id)?.agent === 'Claude Code'));
    if (!folder || !ids.size) return;
    const files = [...ids].some(id => !calls.get(id).filename) ? await fs.readdir(folder).catch(() => []) : [...ids].map(id => path.basename(calls.get(id).filename).replace(/\.jsonl$/, '.meta.json'));
    if (this.calls !== calls) return;
    const matches = new Map();
    for (const name of files) {
      if (!/^agent-[\w-]+\.meta\.json$/.test(name)) continue;
      const filename = path.join(folder, name), stat = await fs.stat(filename).catch(() => null);
      if (this.calls !== calls) return;
      if (!stat || stat.size > 64 * 1024) continue;
      let entry = this.meta.get(filename);
      if (!entry || entry.at !== stat.mtimeMs || entry.size !== stat.size) {
        try { entry = { at: stat.mtimeMs, size: stat.size, value: JSON.parse(await fs.readFile(filename, 'utf8')) }; } catch { continue; }
        if (this.calls !== calls) return;
        this.meta.set(filename, entry);
      }
      if (ids.has(entry.value?.toolUseId)) {
        const id = entry.value.toolUseId;
        if (!matches.has(id)) matches.set(id, { ...entry.value, filename: filename.replace(/\.meta\.json$/, '.jsonl') });
        else matches.set(id, null);
      }
    }
    for (const id of ids) {
      const call = calls.get(id), meta = matches.get(id);
      const filename = matches.has(id) && !meta ? null : meta?.filename || (call?.agentId && path.join(folder, `agent-${call.agentId}.jsonl`)) || call?.filename;
      if (!call || this.calls !== calls) continue;
      call.filename = filename || null;
      await this.readWorker(call, call.filename, calls, meta);
      if (this.calls !== calls || this.folder !== folder) return;
    }
  }
  async readLog(call, calls) {
    let file;
    try {
      file = await fs.open(call.log, 'r');
      const stat = await file.stat({ bigint: true }), size = Number(stat.size), identity = `${stat.dev}:${stat.ino}`;
      if (call.logIdentity !== identity || size < call.logSize) {
        call.logIdentity = identity; call.logOffset = 0; call.logBuffer = ''; call.logTail = ''; call.logSkipping = false; call.headerDone = false; call.plainLog = false;
        call.plainIds = new Set(); call.jsonIds = new Set(); call.threadId = null;
        this.bind(call, null);
      }
      call.logSize = size;
      const accept = chunk => {
        const body = (call.logTail + chunk.toString('utf8')).replace(/\x1b\[[0-9;]*m/g, '');
        const working = /(?:^|\n)(?:codex|thinking|exec|tool [^\r\n]+|apply_patch)\r?\n[^\r\n]/.test(body);
        call.logTail = body.slice(-1024);
        const lines = (call.logBuffer + chunk.toString('utf8')).split('\n'); call.logBuffer = lines.pop();
        for (const raw of lines) {
          if (call.logSkipping) { call.logSkipping = false; continue; }
          const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
          const id = !call.headerDone && /^session id:\s*([a-f\d-]{36})$/i.exec(line)?.[1];
          if (id && call.plainIds.size < 2) call.plainIds.add(id);
          if (line === 'user') { call.headerDone = true; call.plainLog = true; }
          if (/^OpenAI Codex\b/.test(line)) call.plainLog = true;
          if (call.plainLog) continue;
          try {
            const item = JSON.parse(line);
            if (item.type === 'thread.started' && /^[a-f\d-]{36}$/i.test(item.thread_id) && call.jsonIds.size < 2) call.jsonIds.add(item.thread_id);
            if (['item.started', 'item.completed'].includes(item.type)) { call.preparing = false; call.headerDone = true; }
          } catch { }
        }
        if (call.logBuffer.length > 4096) { call.logBuffer = ''; call.logSkipping = true; }
        if (working) { call.preparing = false; call.headerDone = true; }
      };
      // The ID is in the header; old output needs only a bounded initial tail for the preparing state.
      if (!call.logOffset && size > 256 * 1024) {
        const head = Buffer.alloc(4096), { bytesRead } = await file.read(head, 0, head.length, 0);
        accept(head.subarray(0, bytesRead)); call.logBuffer = ''; call.logSkipping = true; call.logOffset = size - 256 * 1024;
      }
      const end = Math.min(size, call.logOffset + 4 * 1024 * 1024);
      while (call.logOffset < end) {
        const chunk = Buffer.alloc(Math.min(65536, end - call.logOffset));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, call.logOffset);
        if (this.calls !== calls) return;
        if (!bytesRead) break;
        call.logOffset += bytesRead; accept(chunk.subarray(0, bytesRead));
      }
      const ids = call.plainIds.size ? call.plainIds : call.jsonIds;
      call.threadId = ids.size === 1 ? [...ids][0] : null;
    } catch (error) {
      // tool_use can arrive before the shell creates its redirected log.
      call.headerDone = error.code !== 'ENOENT'; call.threadId = null;
      if (call.headerDone) call.preparing = false;
    }
    finally { await file?.close(); }
  }
  async readExec(call, calls) {
    if (!call.log) return;
    await this.readLog(call, calls);
    if (this.calls !== calls) return;
    const conflicts = call.threadId ? [...calls.values()].filter(other => other !== call && other.threadId === call.threadId) : [];
    if (!call.threadId || conflicts.length) {
      for (const other of conflicts) this.bind(other, null);
      this.bind(call, null); return;
    }
    const candidates = (await rolloutFiles(this.directory)).filter(item => item.name.includes(call.threadId));
    const matches = [];
    for (const item of candidates) {
      const meta = await sessionMeta(item.filename).catch(() => null);
      if (this.calls !== calls) return;
      if (meta?.id === call.threadId && meta.source === 'exec') matches.push(item.filename);
    }
    if (this.calls !== calls) return;
    await this.readWorker(call, matches.length === 1 ? matches[0] : null, calls);
  }
}

module.exports = { AgentCalls, codexCall };
