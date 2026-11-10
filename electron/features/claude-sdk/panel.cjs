// The facts behind Claude's /context, /cost, /status and /usage in native mode. They answer a send in its receipt's `local` field and are never an item of the
// conversation or a message to the model. Every value comes from the SDK or from what this session already saw; one that is not there is null, never a
// guess, and the owner's window says 未知.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const money = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) : null;
const text = (value, limit = 200) => typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const COMMAND = /^\/(context|cost|status|usage)$/;
const panelCommand = words => COMMAND.exec(words.trim())?.[1] ?? null;

async function within(task, milliseconds) {
  let timer;
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

const largest = (rows, size = 5) => rows.filter(row => row.tokens > 0).sort((a, b) => b.tokens - a.tokens).slice(0, size);
const named = (rows, name, tokens, label = value => value, size = 5) => largest(list(rows).flatMap(row => {
  const found = text(object(row)[name]), used = count(object(row)[tokens]);
  return found && used !== null ? [{ name: label(found), tokens: used }] : [];
}), size);

// A category as the SDK names it: its `kind` says whether it is used context, free space, the compaction buffer or deferred; `id` is its stable name. The
// window decides what to draw from these two, never from the English `name`.
const KINDS = new Set(['used', 'free', 'buffer', 'deferred']);
const categories = rows => largest(list(rows).flatMap(row => {
  const found = object(row), name = text(found.name, 80), used = count(found.tokens);
  return name && used !== null ? [{ id: text(found.id, 60), name, tokens: used, kind: KINDS.has(found.kind) ? found.kind : null }] : [];
}), 16);

// getContextUsage() of the SDK query: the window, the tokens in it and what they are made of.
function contextFacts(raw) {
  const context = object(raw), servers = new Map();
  for (const row of list(context.mcpTools).map(object)) {
    const server = text(row.serverName) ?? text(row.name), used = count(row.tokens);
    if (server && used) servers.set(server, (servers.get(server) || 0) + used);
  }
  return {
    model: text(context.model), tokens: count(context.totalTokens), window: count(context.rawMaxTokens) ?? count(context.maxTokens),
    autoCompact: typeof context.isAutoCompactEnabled === 'boolean' ? context.isAutoCompactEnabled : null, autoCompactThreshold: count(context.autoCompactThreshold),
    categories: categories(context.categories),
    memory: named(context.memoryFiles, 'path', 'tokens', value => value.split(/[\\/]/).pop() || value),
    mcp: largest([...servers].map(([name, tokens]) => ({ name, tokens }))),
    skills: named(object(context.skills).skillFrontmatter, 'name', 'tokens'),
  };
}

// What the results of this session add up to. A result's totals are cumulative for the conversation (a resumed one starts from its history), so the
// newest one stands; durations are per result and are added up from when this session was opened. A zeroed failure is no new total.
function createTally() {
  let cost = null, models = [], durationMs = null, apiDurationMs = null;
  const add = (total, value) => value === null ? total : (total ?? 0) + value;
  return {
    result(message) {
      if (message.is_error === true && !(message.total_cost_usd > 0)) return;
      cost = money(message.total_cost_usd) ?? cost;
      const usage = Object.entries(object(message.modelUsage)).map(([model, row]) => ({ model: model.slice(0, 120), costUsdMicros: money(object(row).costUSD),
        input: count(object(row).inputTokens), output: count(object(row).outputTokens), cacheRead: count(object(row).cacheReadInputTokens), cacheWrite: count(object(row).cacheCreationInputTokens) }));
      if (usage.length) models = usage;
      durationMs = add(durationMs, count(message.duration_ms)); apiDurationMs = add(apiDurationMs, count(message.duration_api_ms));
    },
    facts() {
      const sum = field => models.length && models.every(row => row[field] !== null) ? models.reduce((total, row) => total + row[field], 0) : null;
      return { costUsdMicros: cost, durationMs, apiDurationMs, models: models.slice(0, 8),
        tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') } };
    },
  };
}

// The system init message of a query: only what the owner's window shows.
function initFacts(message) {
  return { version: text(message.claude_code_version, 40), permission: text(message.permissionMode, 40),
    mcp: list(message.mcp_servers).flatMap(row => text(object(row).name, 80) ? [{ name: text(row.name, 80), status: text(row.status, 40) }] : []).slice(0, 12) };
}

const buckets = limits => Object.entries(object(limits?.limitsById)).flatMap(([id, bucket]) => {
  const window = object(object(bucket).primary);
  return [{ id: id.slice(0, 40), usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null, resetsAtMs: count(window.resetsAtMs) }];
});

// `read` fetches the SDK's context usage (only /context and /status need it); `session()` is what the session itself holds, read once the context is.
async function answer(command, { read, tally, session, summary, budgetUsd, limits, connection, init }) {
  let context = null;
  const errors = [];
  if (read) {
    try { context = contextFacts(await within(read(), 10000)); }
    catch {
      if (command === 'context') throw new Error('无法读取上下文用量。');
      errors.push({ source: 'context', reason: '原因未知' });
    }
  }
  const month = { spentMicros: count(summary.monthUsdMicros), budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : null };
  const base = { agent: 'claude', command };
  if (command === 'context') return { ...base, context };
  if (command === 'cost') return { ...base, ...tally.facts(), month };
  if (command === 'usage') {
    const { tokens } = tally.facts(), notice = limits?.notice;
    return { ...base, month, today: { spentMicros: count(summary.todayUsdMicros) }, tokens, limits: buckets(limits),
      notice: notice ? { code: text(notice.code, 40), resetsAtMs: count(notice.resetsAtMs) } : null };
  }
  return { ...base, context, errors, session: { ...session(), version: init?.version ?? null, permission: init?.permission ?? null, mcp: init?.mcp ?? [] },
    account: { kind: connection?.kind ?? 'unknown' } };
}

module.exports = { panelCommand, answer, createTally, initFacts, contextFacts };
