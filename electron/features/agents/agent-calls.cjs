const fs = require('node:fs/promises');
const path = require('node:path');
const { claudePrompt, resolvePath } = require('../../agent-actions.cjs');

const text = value => typeof value === 'string' ? value : '';
const short = value => text(value).replace(/\s+/g, ' ').trim().slice(0, 240);
const enabled = value => value === true || value === 'true';
const unquote = value => value.replace(/["']/g, '');
const basename = value => value.split(/[\\/]/).at(-1);
const agentRoles = new Map(Object.entries({ Explore: '搜索', Plan: '规划', 'general-purpose': '通用', claude: '通用', none: '通用', fork: '分身' }));

// Only inspect the command, never evaluate shell syntax. Keep quoted config values together.
function codexCall(command, cwd) {
  const tokens = text(command).match(/\d?>&\d|&>>?|\d?>>?|<|(?:[^\s"';&|<>]+|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|\n]/g) || [];
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
      const filename = tokens[++i].startsWith("'") ? words[i] : expand(words[i]);
      const resolved = /[$`]|^(?:nul|\/dev\/null)$/i.test(filename) ? null : resolvePath(cwd, filename);
      if (input) { task = basename(filename); prompt = resolved; } else log = resolved;
    }
  }
  return { model, effort, fast, provider, task, log, prompt };
}

// Bound reads: prompt titles need the beginning; transcripts and logs need a tail without a cut first line.
async function readText(filename, limit = 256 * 1024, head = false) {
  let file;
  try {
    file = await fs.open(filename, 'r');
    const { size } = await file.stat(), offset = head ? 0 : Math.max(0, size - limit), buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const body = buffer.subarray(0, bytesRead).toString('utf8');
    return offset ? body.slice(body.includes('\n') ? body.indexOf('\n') + 1 : body.length) : body;
  } catch { return null; } finally { await file?.close(); }
}

class AgentCalls {
  constructor({ changed = () => {}, names = id => id === 'openai' ? 'OpenAI' : id } = {}) {
    this.changed = changed; this.names = names; this.folder = null; this.reset();
  }
  reset() { clearTimeout(this.timer); this.timer = null; this.calls = new Map(); this.meta = new Map(); this.pending = new Set(); this.work = null; }
  setFolder(folder) { if (folder !== this.folder) { this.reset(); this.folder = folder; } }
  snapshot(provider) {
    const groups = new Map();
    for (const call of this.calls.values()) {
      if (call.reviewed) continue;
      const route = { agent: call.agent, provider: call.agent === 'Claude Code' ? provider ?? null : this.names(call.provider), model: call.model, effort: call.effort, fast: call.fast };
      const key = JSON.stringify(route);
      if (!groups.has(key)) groups.set(key, { ...route, preparing: 0, running: 0, reviewing: 0, tasks: [], items: [] });
      const group = groups.get(key);
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
      if (record.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && !this.calls.has(block.id)) {
        const input = block.input || {}, codex = block.name === 'Bash' ? codexCall(input.command, record.cwd) : null;
        if (block.name !== 'Agent' && !codex) continue;
        this.calls.set(block.id, {
          agent: codex ? 'Codex' : 'Claude Code', provider: codex?.provider ?? null,
          model: codex?.model || text(input.model) || text(record.message?.model) || 'default',
          resolved: text(input.model).startsWith('claude-'),
          effort: codex?.effort ?? null, fast: codex?.fast ?? null,
          task: short(input.description || block.description || codex?.task || input.subagent_type || block.name),
          title: text(codex?.task || input.description || block.description || input.subagent_type || block.name).replace(/\s+/g, ' ').trim(),
          role: codex ? '执行' : agentRoles.get(input.subagent_type) || text(input.subagent_type) || '通用',
          prompt: this.folder ? codex?.prompt : null,
          background: enabled(input.run_in_background), done: false, preparing: codex ? !!codex.log : !!this.folder, log: codex?.log,
        });
        this.refresh(block.id);
        changed = true;
      } else if (record.type === 'user' && block.type === 'tool_result') {
        const call = this.calls.get(block.tool_use_id);
        if (!call || call.reviewed) continue;
        const result = record.toolUseResult || {};
        call.background ||= enabled(result.isAsync) || !!result.backgroundTaskId;
        if (call.agent === 'Codex' && typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) call.backgroundTaskId = result.backgroundTaskId;
        if ((block.is_error || !call.background) && !call.done) { call.done = true; call.finishedAt = at; changed = true; }
        if (call.agent === 'Claude Code') {
          if (typeof result.resolvedModel === 'string' && result.resolvedModel) { changed ||= call.model !== result.resolvedModel; call.model = result.resolvedModel; call.resolved = true; }
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
          if (call.agent === 'Claude Code') this.refresh(id);
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
    this.schedule();
    return changed;
  }
  // Only preparing calls need a quiet-lead check; generation identity cancels even an already queued callback.
  schedule() {
    if (![...this.calls.values()].some(call => call.preparing && !call.done && !call.reviewed)) { clearTimeout(this.timer); this.timer = null; return; }
    if (this.timer || this.work) return;
    const calls = this.calls;
    this.timer = setTimeout(() => {
      if (this.calls !== calls) return;
      this.timer = null;
      for (const [id, call] of calls) if (call.preparing && !call.done && !call.reviewed) this.refresh(id);
    }, 2500);
    this.timer.unref();
  }
  // Batch related history records; once discovered, preparing checks read just the worker's file.
  refresh(id) {
    if (!this.folder && !this.calls.get(id)?.log) return;
    clearTimeout(this.timer); this.timer = null;
    this.pending.add(id);
    if (this.work) return;
    const calls = this.calls, pending = this.pending, folder = this.folder;
    this.work = Promise.resolve().then(async () => {
      while (pending.size && this.calls === calls) {
        const ids = new Set(pending); pending.clear();
        await this.readModels(folder, ids, calls);
        if (this.calls !== calls) return;
        for (const id of ids) {
          const call = calls.get(id);
          if (!call || call.reviewed) continue;
          const filename = call.prompt; call.prompt = null;
          const prompt = filename ? await readText(filename, 4096, true) : null;
          if (this.calls !== calls) return;
          if (call.reviewed) continue;
          if (prompt !== null) {
            const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(prompt.replace(/^\uFEFF/, ''))?.[1];
            const title = heading?.replace(/^Task\s+[\w-]+(?:\s*\([^)]*\))?\s*[:：]\s*/i, '').trim() || call.title;
            const role = /\bread[- ]only\b|只读/i.test([heading, ...prompt.split(/\r?\n/, 20)].join('\n')) ? '调查' : '执行';
            if (title !== call.title || role !== call.role) { call.title = title; call.role = role; this.changed(); }
          }
          if (!call.preparing || call.done || call.agent !== 'Codex') continue;
          const body = await readText(call.log);
          if (this.calls !== calls) return;
          if (call.done || call.reviewed) continue;
          // Plain exec logs echo a header and prompt; a reply, reasoning or tool invocation starts model work.
          if (body === null || /(?:^|\n)(?:codex|thinking|exec|tool [^\r\n]+|apply_patch)\r?\n[^\r\n]/.test(body.replace(/\x1b\[[0-9;]*m/g, ''))) { call.preparing = false; this.changed(); }
        }
      }
    }).catch(() => {}).finally(() => { if (this.calls === calls) { this.work = null; this.schedule(); } });
  }
  async readModels(folder, ids, calls) {
    ids = new Set([...ids].filter(id => calls.get(id)?.agent === 'Claude Code' && !calls.get(id).reviewed));
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
      if (ids.has(entry.value?.toolUseId)) matches.set(entry.value.toolUseId, { ...entry.value, filename: filename.replace(/\.meta\.json$/, '.jsonl') });
    }
    for (const id of ids) {
      const call = calls.get(id), meta = matches.get(id);
      const filename = call?.filename || meta?.filename || (call?.agentId && path.join(folder, `agent-${call.agentId}.jsonl`));
      if (!call || call.reviewed || !filename || this.calls !== calls) continue;
      call.filename = filename;
      const records = (await readText(filename) || '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      if (this.calls !== calls || this.folder !== folder) return;
      let changed = false;
      if (call.preparing && !call.done && records.some(record => record.type === 'assistant')) { call.preparing = false; changed = true; }
      const model = records.findLast(record => record.type === 'assistant' && record.message?.model && record.message.model !== '<synthetic>')?.message.model;
      // A full id from the transcript outranks the alias in meta. Don't replace a resolved id with an alias.
      const next = model || (typeof meta?.model === 'string' && (!call.resolved || meta.model.startsWith('claude-')) ? meta.model : null);
      if (model || (typeof next === 'string' && next.startsWith('claude-'))) call.resolved = true;
      if (typeof next === 'string' && next && next !== call.model) { call.model = next; changed = true; }
      if (changed && !call.reviewed) this.changed();
    }
  }
}

module.exports = { AgentCalls, codexCall };
