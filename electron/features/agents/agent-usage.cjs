const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { claudePrompt } = require('../../agent-actions.cjs');
const { AgentCalls } = require('./agent-calls.cjs');
const { TokenRates } = require('./token-rate.cjs');
const { DIRECT_USAGE_FRESH_MS } = require('./claude-account-usage.cjs');

// What an agent spends, as its own records tell it, for the activity pane: the service its model is reached through,
// how full the context window is, the tokens this round and this conversation took and, for Codex, how much of the
// plan's 5-hour and weekly allowance is used.
//
// Codex writes a token_count event after each model call: the conversation's running totals, the last call's size (the
// context it filled), the window and the plan's rate limits. Claude Code writes each reply's usage with the reply, and
// every piece of one reply repeats it, so a reply counts once. Claude's records hold no plan limits, and its
// conversation total is known only when the part read reaches back to the conversation's first prompt.
//
// Tokens are { input, cached, output }: input counts the cached part too; output counts the reasoning too.
const ZERO = { input: 0, cached: 0, output: 0 };
const count = value => Number.isFinite(value) && value > 0 ? value : 0;
const plus = (a, b, sign = 1) => ({ input: a.input + sign * b.input, cached: a.cached + sign * b.cached, output: a.output + sign * b.output });

// Claude models from Opus 4.7 on (and Sonnet 5, Haiku 5.5, Fable, Mythos) have a 1M-token window; older ones 200k
// unless named with [1m]. A context larger than 200k shows the window is the large one, whatever the name says.
const LARGE_WINDOW = /\[1m\]|claude-(?:opus-4-[7-9]|(?:opus|sonnet|haiku)-(?:[5-9]|\d{2,})|fable|mythos)/i;
const claudeWindow = (model, used) => LARGE_WINDOW.test(model || '') || used > 200000 ? 1000000 : 200000;

// provider: Claude's, known when it starts. Codex names its own in each conversation's first record; names turns that
// id into what the pane shows.
class UsageMeter {
  constructor(agent, { provider = null, names = codexProviderName, changed = () => {}, rates = true, codexHome } = {}) {
    this.agent = agent; this.provider = provider; this.names = names; this.providerId = null; this.limits = [];
    this.resets = null; this.limitsAt = null; this.claudeDirect = null;
    this.rates = new TokenRates(agent); this.readRates = rates; this.mainCodex = true;
    this.calls = new AgentCalls({ changed, names: id => this.names(id), local: rates, codexHome });
    this.reset();
  }
  // Claude's plan limits from the read-only account query or the existing local caches.
  account(account, direct = null) {
    if (this.agent !== 'claude') return false;
    const now = Date.now();
    for (const candidate of [account, direct]) {
      if (candidate?.source === 'Claude' && Array.isArray(candidate.limits) && candidate.limits.length && Number.isFinite(candidate.at) && candidate.at <= now &&
        candidate.at > (this.claudeDirect?.at ?? -Infinity)) this.claudeDirect = candidate;
    }
    // A cache read started before a GET can finish afterward. Keep the current
    // direct observation as its comparison point, even when a newer cache wins.
    if (freshClaudeUsage(this.claudeDirect, now)) account = selectClaudeAccount(account?.source === 'Claude Code' ? account : null, null, this.claudeDirect, now);
    return !!account && this.observeLimits(account.limits, account.at, account.source);
  }
  // Sanitized official Codex account read. Null/unavailable never means zero.
  codexAccount(account) {
    if (this.agent !== 'codex' || !account?.resetQuery) return false;
    this.resets = account.resets; this.resetQuery = account.resetQuery;
    this.observeLimits(account.limits, account.at, account.source);
    return true;
  }
  observeLimits(limits, at, source = null) {
    if (!Array.isArray(limits) || !limits.length) return false;
    at = Number.isFinite(at) ? at : null;
    // An undated cache or replay cannot prove it is newer than a dated observation.
    const observed = this.agent === 'claude' && this.limitsFrom === 'CodePulse' && freshClaudeUsage(this.claudeDirect) &&
      ['Claude', 'Claude Code'].includes(source) && at != null && at >= this.claudeDirect.at;
    if (!observed && this.limitsAt != null && (at == null || at < this.limitsAt)) return false;
    if (at === this.limitsAt && source === (this.limitsFrom ?? null) && limits.length === this.limits.length &&
      limits.every((value, i) => value.minutes === this.limits[i].minutes && value.percent === this.limits[i].percent && value.resetsAt === this.limits[i].resetsAt)) return false;
    this.limits = limits; this.limitsAt = at; this.limitsFrom = source;
    return true;
  }
  // Another conversation starts over; the provider and the plan's limits stay.
  reset() { this.context = null; this.round = null; this.total = null; this.roundStart = null; this.replies = new Map(); this.rates.reset(); this.calls.reset(); }
  resetScope() {
    this.providerId = null; this.scopeCwd = null; this.resets = null;
    this.limits = []; this.limitsAt = null; this.limitsFrom = null; this.claudeDirect = null;
    this.resetQuery = { state: 'unavailable', reason: 'scope' };
  }
  // What the pane shows.
  snapshot(history = null) {
    const provider = this.providerId ? this.names(this.providerId) : this.provider;
    // History holds conversation totals, never a newer account observation.
    return { ...(history || { provider, context: this.context, round: this.round, total: this.total, calls: this.calls.snapshot(provider),
      model: this.rates.model, rate: this.readRates ? this.rates.snapshot() : null }),
      limits: this.limits, limitsAt: this.limitsAt, limitsFrom: this.limitsFrom ?? null, resets: this.resets,
      ...(this.resetQuery ? { resetQuery: this.resetQuery } : {}) };
  }
  // Whether this record changed what the pane shows.
  apply(record) {
    if (!record || typeof record !== 'object') return false;
    if (this.agent !== 'claude') {
      if (record.type === 'session_meta') this.mainCodex = record.payload?.source !== 'exec';
      if (!this.mainCodex) return false;
      const changed = this.codex(record);
      return this.rates.apply(record) || changed;
    }
    if (record.isSidechain) return false;
    const callsChanged = this.calls.apply(record);
    const rateChanged = this.rates.apply(record);
    return this.claude(record) || callsChanged || rateChanged;
  }
  claude(record) {
    if (record.isSidechain) return false;
    // A prompt starts a round, told by time: Claude Code writes a session's first prompt after the reply to it, so the
    // replies stamped after the prompt stay in its round. A round whose prompt lies before the part read stays unknown.
    if (claudePrompt(record)) {
      const at = Date.parse(record.timestamp);
      for (const [id, reply] of this.replies) if (!(reply.at > at)) this.replies.delete(id);
      this.round = [...this.replies.values()].reduce((sum, reply) => plus(sum, reply.tokens), { ...ZERO });
      // The conversation's first prompt answers nothing before it: from here its total is known.
      if (record.parentUuid === null) this.total = { ...this.round };
      return true;
    }
    const message = record.message, usage = message?.usage;
    if (record.type !== 'assistant' || !usage || typeof usage !== 'object' || message.model === '<synthetic>') return false;
    const prompt = count(usage.input_tokens), written = count(usage.cache_creation_input_tokens), read = count(usage.cache_read_input_tokens);
    const tokens = { input: prompt + written + read, cached: read, output: count(usage.output_tokens) };
    if (!tokens.input && !tokens.output) return false;
    // The replies since the last prompt, by id: a later piece of a reply replaces what an earlier one counted.
    const id = message.id || record.uuid, earlier = this.replies.get(id)?.tokens;
    const add = sum => plus(earlier ? plus(sum, earlier, -1) : sum, tokens);
    this.replies.set(id, { at: Date.parse(record.timestamp), tokens });
    if (this.round) this.round = add(this.round);
    if (this.total) this.total = add(this.total);
    const used = tokens.input + tokens.output;
    this.context = { used, window: claudeWindow(message.model, used) };
    return true;
  }
  codex(record) {
    const payload = record.payload || {};
    if (record.type === 'session_meta') {
      this.reset();
      this.providerId = typeof payload.model_provider === 'string' && payload.model_provider ? payload.model_provider : null;
      this.scopeCwd = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : null;
      return true;
    }
    if (record.type !== 'event_msg') return false;
    if (['task_started', 'turn_started'].includes(payload.type)) { this.roundStart = this.total || { ...ZERO }; this.round = { ...ZERO }; return true; }
    if (payload.type !== 'token_count') return false;
    const info = payload.info && typeof payload.info === 'object' ? payload.info : null;
    const total = tokensOf(info?.total_token_usage), last = info?.last_token_usage;
    if (total) {
      this.total = total;
      if (this.roundStart) this.round = plus(total, this.roundStart, -1);
    }
    const context = last && Number.isFinite(last.total_tokens) && count(info.model_context_window)
      ? { used: count(last.total_tokens), window: info.model_context_window } : null;
    const contextChanged = !!context && (context.used !== this.context?.used || context.window !== this.context?.window);
    if (context) this.context = context;
    const limits = payload.rate_limits && typeof payload.rate_limits === 'object' ? [payload.rate_limits.primary, payload.rate_limits.secondary]
      .filter(window => window && Number.isFinite(window.used_percent))
      .map(window => ({ minutes: count(window.window_minutes) || null, percent: window.used_percent, resetsAt: count(window.resets_at) ? window.resets_at * 1000 : null })) : null;
    const limitsChanged = this.observeLimits(limits, Date.parse(record.timestamp), 'Codex');
    return !!total || contextChanged || limitsChanged;
  }
}
function tokensOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return { input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens) };
}

// The service behind a Codex model_provider id: its own names for the built-in ones, else the host of the base_url
// that config.toml gives the provider, else the id.
const CODEX_PROVIDERS = { openai: 'OpenAI', azure: 'Azure OpenAI', ollama: 'Ollama', oss: 'Ollama', lmstudio: 'LM Studio' };
function codexProviderName(id, config = '') {
  if (CODEX_PROVIDERS[id]) return CODEX_PROVIDERS[id];
  const header = new RegExp(`^\\s*\\[model_providers\\.(?:${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|"${id.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')}")\\]\\s*$`, 'm').exec(config);
  const section = header ? config.slice(header.index + header[0].length).split(/^\s*\[/m)[0] : '';
  return hostOf(/^\s*base_url\s*=\s*["']([^"']+)["']/m.exec(section)?.[1]) || id;
}
async function codexProvider(codexHome) {
  const config = await fs.readFile(path.join(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8').catch(() => '');
  return id => codexProviderName(id, config);
}

// Where Claude Code sends its requests: Bedrock, Vertex or Foundry when switched on, else ANTHROPIC_BASE_URL's host when
// it points elsewhere than Anthropic. Its settings files set environment variables over the inherited ones, the
// project's local file over the project's over the user's.
const on = value => /^(?:1|true|yes|on)$/i.test(String(value ?? '').trim());
function hostOf(url) { try { return new URL(String(url)).host || null; } catch { return null; } }
function claudeProviderName(env) {
  if (on(env.CLAUDE_CODE_USE_BEDROCK)) return 'Amazon Bedrock';
  if (on(env.CLAUDE_CODE_USE_VERTEX)) return 'Google Vertex AI';
  if (on(env.CLAUDE_CODE_USE_FOUNDRY)) return 'Microsoft Foundry';
  const host = hostOf(env.ANTHROPIC_BASE_URL);
  return host && host !== 'api.anthropic.com' ? host : 'Anthropic';
}
async function claudeProvider(cwd, configDir, env = process.env) {
  const files = [path.join(configDir, 'settings.json'), ...(cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : [])];
  const merged = { ...env };
  for (const file of files) {
    try { const settings = JSON.parse(await fs.readFile(file, 'utf8')); if (settings?.env && typeof settings.env === 'object') Object.assign(merged, settings.env); } catch { }
  }
  return claudeProviderName(merged);
}

// Claude's plan limits are not in its transcript: Claude Code fetches them for /usage and its status line and keeps the
// latest in its own state file (.claude.json beside its config folder, or in CLAUDE_CONFIG_DIR): the 5-hour and weekly
// windows. Read, never written; null when it holds none.
const claudeState = () => process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
function claudeAccountFrom(state) {
  const cached = state?.cachedUsageUtilization, usage = cached?.utilization && typeof cached.utilization === 'object' ? cached.utilization : null;
  if (!usage) return null;
  const window = (value, minutes) => value && Number.isFinite(value.utilization)
    ? { minutes, percent: value.utilization, resetsAt: Date.parse(value.resets_at) || null } : null;
  const limits = [window(usage.five_hour, 300), window(usage.seven_day, 10080)].filter(Boolean);
  return { limits, at: Number.isFinite(cached?.fetchedAtMs) ? cached.fetchedAtMs : null, source: 'Claude Code' };
}
// CodePulse's updatedAt dates a status-line write, not the underlying usage observation.
// It watches the Claude Code of the usual config folder: a Claude given its own CLAUDE_CONFIG_DIR is another setup.
const codePulseFile = () => process.env.CLAUDE_CONFIG_DIR ? null : path.join(os.homedir(), '.codepulse', 'claude-quota.json');
const claudeAccountFiles = () => [claudeState(), codePulseFile()].filter(Boolean);
function codePulseLimits(quota) {
  const limits = quota?.rate_limits;
  if (!limits || typeof limits !== 'object' || !Number.isFinite(quota.updatedAt)) return null;
  const window = (value, minutes) => value && Number.isFinite(value.used_percent)
    ? { minutes, percent: value.used_percent, resetsAt: Number.isFinite(value.resets_at) ? value.resets_at * 1000 : null } : null;
  const list = [window(limits.five_hour, 300), window(limits.seven_day, 10080)].filter(Boolean);
  return list.length ? { limits: list, at: quota.updatedAt, source: 'CodePulse' } : null;
}
function freshClaudeUsage(account, now = Date.now()) {
  return account?.source === 'Claude' && Number.isFinite(account.at) && account.at <= now && now - account.at < DIRECT_USAGE_FRESH_MS;
}
function selectClaudeAccount(own, pulse, direct, now = Date.now()) {
  // Redrawing a stale status line must not displace a recent GET. Claude's own
  // fetchedAtMs really is an observation, so a newer one can still win.
  if (freshClaudeUsage(direct, now)) return own?.limits?.length && own.at > direct.at ? own : direct;
  return [own, pulse, direct].filter(account => account?.limits?.length).reduce((latest, account) =>
    !latest || (account.at ?? 0) > (latest.at ?? 0) ? account : latest, null);
}
async function claudeAccount(file = claudeState(), pulse = codePulseFile(), direct = null) {
  const read = async name => { try { return name ? JSON.parse(await fs.readFile(name, 'utf8')) : null; } catch { return null; } };
  const [state, quota] = await Promise.all([read(file), read(pulse)]);
  return selectClaudeAccount(claudeAccountFrom(state), codePulseLimits(quota), direct);
}

module.exports = { UsageMeter, claudeWindow, claudeProvider, claudeProviderName, codexProvider, codexProviderName, claudeAccount, claudeAccountFrom, claudeAccountFiles, codePulseLimits, selectClaudeAccount };
