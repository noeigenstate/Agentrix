// How the model's items and states read: the text an item shows (tolerant of the shapes the two runtimes give — a field that is absent is
// absent, never guessed) and the words for states, receipts, routes and money.
//
// The item content fields read here: messages, reasoning summaries and plans `text` (a string, or blocks with `text`; a reasoning summary
// may also give `summary`); the owner's message `clientMessageId`; commands `command` (string or list), `cwd`, `exitCode`, `durationMs`, `output`;
// file changes `changes[{ path, kind, diff }]` or `path`, `kind`, `diff`; tools `name` or `tool`, `server`, `input` or `arguments`, `result` or
// `output`. Quota windows are `{ usedPercent, windowDurationMins, resetsAtMs }` with `resetsAtMs` in milliseconds.
import { t } from '../../shared/i18n';
import type { AgentConnection, ConnectionTest, LimitWindow, NativeAgent, SwitchState } from './native-bridge.ts';
import type { NativeItem, Payload } from './native-model.ts';

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const list = (value: unknown): Payload[] => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') as Payload[] : []);
const lines = (value: unknown) => (Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry : (str((entry as Payload | null)?.text) ?? '')).filter(Boolean).join('\n') : (str(value) ?? ''));
const preview = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2));

// ── Items ──
export const messageText = (item: NativeItem) => item.deltas.text || lines(item.content.text) || lines(item.content.content);
export const reasoningText = (item: NativeItem) => item.deltas.reasoning.filter(Boolean).join('\n\n') || lines(item.content.text) || lines(item.content.summary);
export const planText = (item: NativeItem) => item.deltas.plan || lines(item.content.text);

export function commandOf(item: NativeItem) {
  const { command, cwd, exitCode, durationMs, output } = item.content;
  return {
    command: Array.isArray(command) ? command.join(' ') : (str(command) ?? ''), cwd: str(cwd),
    exitCode: typeof exitCode === 'number' ? exitCode : null, durationMs: typeof durationMs === 'number' ? durationMs : null, output: item.deltas.output || (str(output) ?? ''),
  };
}

export function fileChanges(item: NativeItem) {
  const found = list(item.content.changes).map(change => ({ path: str(change.path) ?? '', kind: str(change.kind), diff: str(change.diff) ?? '' }));
  return found.length ? found : [{ path: str(item.content.path) ?? '', kind: str(item.content.kind), diff: str(item.content.diff) ?? '' }];
}

export function toolOf(item: NativeItem) {
  const { name, tool, server, input, arguments: args, result, output } = item.content;
  return { name: str(name) ?? str(tool) ?? t('工具'), server: str(server), input: preview(input ?? args), result: preview(result ?? output) };
}

// The mark on a step: running turns, done ticks, failed crosses; a status the item does not give (or one we do not know) has no mark.
export type StepMark = 'running' | 'done' | 'failed' | null;
export function itemState(item: NativeItem): StepMark {
  const status = item.status?.toLowerCase() ?? '';
  if (/^(running|in[_ -]?progress|started|pending|active)$/.test(status)) return 'running';
  if (/^(completed?|done|success|succeeded)$/.test(status)) return 'done';
  return /^(failed|error|errored)$/.test(status) ? 'failed' : null;
}

// ── States ──
const SESSION_WORDS: Record<string, string> = {
  starting: '正在启动', idle: '空闲', running: '工作中', waiting: '等你确认', stopping: '正在停止', stopped: '已结束', disconnected: '连接中断', failed: '出错了',
};
export const sessionWord = (state: string | null | undefined) => (state && SESSION_WORDS[state] ? t(SESSION_WORDS[state]) : t('状态未知'));

const TURN_WORDS: Record<string, string> = { completed: '本轮已完成', failed: '本轮出错', interrupted: '本轮已中断' };
export const turnWord = (status: string | null) => (status && TURN_WORDS[status] ? t(TURN_WORDS[status]) : null);

const RECEIPT_WORDS: Record<string, string> = { queued: '已排队', delivered: '已送达', consumed: '已被读取', rejected: '未送达', unknown: '送达状态未知' };
export const receiptWord = (status: string | null | undefined) => (status && RECEIPT_WORDS[status] ? t(RECEIPT_WORDS[status]) : null);

// The route codes the main process gives for a switch; one it does not know is shown as given, never hidden.
const REASON_WORDS: Record<string, string> = {
  budget_exhausted: '本月 API 预算已用完', credits_exhausted: 'API 额度已用完', rate_limited: 'API 被限流', no_key: '还没有保存 API key',
  native_cli_required: '未找到原生 Claude Code，无法通过 API 运行', settings: '按设置运行', user: '你选择了终端',
  codex_cli_required: '未找到 Codex 命令行，无法使用原生界面', unsupported_codex_version: '这个 Codex 版本不支持原生界面', terminal_selected: '按设置使用终端',
};

// A folder for a single line: short ones whole, long ones as … and their last two parts (the whole path goes in a tooltip).
export function shortPath(path: string, max = 32) {
  if (path.length <= max) return path;
  const separator = path.includes('\\') ? '\\' : '/', parts = path.split(/[\\/]+/).filter(Boolean);
  return `…${separator}${parts.slice(-2).join(separator)}`;
}
export const reasonWords = (reason: string | null | undefined) => (!reason ? null : REASON_WORDS[reason] ? t(REASON_WORDS[reason]) : reason);

export const routeWord = (route: string | null | undefined) => (route === 'api' ? 'API' : route === 'terminal' ? t('终端') : route === 'native' ? t('原生') : route === 'subscription' ? t('订阅') : t('未知'));

// ── The run-mode switch ──
// The header's line while a change is on its way to this session; null when the header has nothing to add (nothing under way, the owner's
// question, which has its card, and a failure, which the path note tells). A reason main gives (an unsent draft in the CLI's own input) is the line.
export function switchLine(state: SwitchState | null | undefined) {
  const path = routeWord(state?.target);
  switch (state?.phase) {
    case 'waiting-turn': return reasonWords(state.reason) ?? t('本轮结束后切到 {path}', { path });
    case 'waiting-background': return t('等后台任务结束后再切到 {path}', { path });
    case 'preparing': case 'switching': return t('正在切到 {path}', { path });
    default: return null;
  }
}

// A switch that failed leaves the session where it was; the note says so with main's reason. null while nothing failed.
export function switchFailure(state: SwitchState | null | undefined) {
  if (!state || !(state.phase === 'rolling-back' || state.phase === 'stable' && state.reason)) return null;
  return [t('没有切换成功，仍使用 {path}', { path: routeWord(state.current) }), reasonWords(state.reason)].filter(Boolean).join(' · ');
}

// What the owner is told before choosing: a switch ends background tasks. Unknown is not none, so no count is guessed.
export const backgroundWords = (background: SwitchState['background']) => (background.known && typeof background.count === 'number'
  ? t('切换会结束 {count} 个后台任务。', { count: background.count }) : t('切换会结束后台任务；现在还不知道有几个在运行。'));

// "Claude · API" or "Codex · 原生": whose session this is and what it runs on.
export function runtimeWord(identity: { provider: string; transport: string } | null) {
  if (!identity) return '';
  return identity.provider === 'claude' ? 'Claude · API' : `Codex · ${t('原生')}`;
}

// ── Numbers ──
// Money is estimated from tokens at public prices; an unknown amount is 未知, never $0.00.
export function money(micros: number | null | undefined) {
  if (typeof micros !== 'number' || !Number.isFinite(micros)) return t('未知');
  return micros > 0 && micros < 10_000 ? '<$0.01' : `$${(micros / 1e6).toFixed(2)}`;
}

export function clockWords(at: number | null | undefined, now = Date.now()) {
  if (typeof at !== 'number') return t('未知');
  const date = new Date(at), time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`;
}

// ── Connections ──
// What an agent is connected through, in the pane's words (the agent's name is the row's label); the source is the tooltip. Not known says so.
const CONNECTION_WORDS: Record<NativeAgent, Record<string, string>> = {
  claude: { api: '已连接 API', subscription: '订阅（Claude Code 登录）', none: '未连接' },
  codex: { api: 'API', subscription: 'ChatGPT 订阅', none: '未连接' },
};
export function connectionWord(agent: NativeAgent, connection: AgentConnection | null | undefined) {
  const word = connection ? CONNECTION_WORDS[agent][connection.kind] : undefined;
  return { text: word ? t(word) : t('未知'), source: connection?.source || null };
}

// The lines of a connection test, each with a tone (ok, warn, bad) the view marks with a symbol as well as colour, and a next step for
// what failed. The key itself is never in a result; a detail is one plain sentence from the main process.
const KEY_WORDS: Record<string, string> = { ok: '有效', missing: '没有保存密钥', invalid: '无效', forbidden: '无权限', rate_limited: '被限流', unreachable: '无法连接', error: '检查出错' };
const KEY_HINTS: Record<string, string> = {
  missing: '先保存 API key，再测试。', invalid: '请检查密钥是否完整，或是否已在 Anthropic 控制台被撤销。', forbidden: '这个密钥没有权限，请到 Anthropic 控制台检查它的权限。',
  rate_limited: '请求太频繁，稍后再测试。', unreachable: '请检查网络或代理设置后重试。', error: '请稍后重试。',
};
const MODELS_SHOWN = 5;
export type TestLine = { id: 'key' | 'models' | 'cli' | 'billing' | 'path'; tone: 'ok' | 'warn' | 'bad'; label: string; text: string; hint: string | null; title: string | null };
const BILLING_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'none', 'user', 'project', 'org', 'temporary', 'oauth']);

function billingLine(test: ConnectionTest): TestLine {
  const source = test.billing?.source, known = source && BILLING_SOURCES.has(source);
  const ok = known && source === 'ANTHROPIC_API_KEY' && test.billing.status === 'ok';
  const mismatch = known && source !== 'ANTHROPIC_API_KEY' && test.billing.status === 'mismatch';
  return { id: 'billing', label: t('计费来源'), tone: ok ? 'ok' : mismatch ? 'bad' : 'warn',
    text: ok || mismatch ? source : t('未知'), title: null,
    hint: ok ? null : mismatch ? test.path === 'terminal'
      ? t('Claude Code 没有使用这个密钥，新会话将走终端。')
      : t('Claude Code 没有使用这个密钥，当前设置不允许启动新会话。')
      : t('无法确认 Claude Code 的计费来源，请重试。') };
}

export function connectionLines(test: ConnectionTest): TestLine[] {
  const { key, models, cli } = test, keyTone = key.status === 'ok' ? 'ok' : key.status === 'rate_limited' ? 'warn' : 'bad';
  const latency = key.status === 'ok' && typeof key.latencyMs === 'number' ? ` · ${Math.round(key.latencyMs)} ms` : '';
  const keyHint = key.status === 'ok' ? null : [t(KEY_HINTS[key.status] ?? KEY_HINTS.error), key.status === 'error' ? key.detail : null].filter(Boolean).join(' ');
  const shown = models?.slice(0, MODELS_SHOWN) ?? [];
  const modelText = !models ? t('未知') : !models.length ? t('没有可用模型') : shown.join('、') + (models.length > shown.length ? ` ${t('等 {n} 个', { n: models.length })}` : '');
  const required = cli.required, version = cli.version;
  const cliText = cli.status === 'ok' ? (version ? t('版本 {version}（满足 ≥ {required}）', { version, required }) : t('已找到（需要 ≥ {required}）', { required }))
    : cli.status === 'missing' ? t('未找到') : version ? t('版本 {version} 过低（需要 ≥ {required}）', { version, required }) : t('版本过低（需要 ≥ {required}）', { required });
  const pathText = test.path === 'api' ? 'API' : test.path === 'terminal' ? t('终端（订阅）') : t('未知');
  return [
    { id: 'key', tone: keyTone, label: t('密钥'), text: (KEY_WORDS[key.status] ? t(KEY_WORDS[key.status]) : t('检查出错')) + latency, hint: keyHint, title: key.detail },
    { id: 'models', tone: models?.length ? 'ok' : 'warn', label: t('可用模型'), text: modelText, hint: null, title: models?.join('\n') || null },
    { id: 'cli', tone: cli.status === 'ok' ? 'ok' : 'bad', label: 'Claude Code', text: cliText, hint: cli.status === 'missing' ? t('请安装 Claude Code（需要 ≥ {required}）。', { required }) : cli.status === 'too_old' ? t('请升级 Claude Code。') : null, title: null },
    // Older callers without the new field retain their rows; the settings page renders absent billing as unknown.
    ...(test.billing ? [billingLine(test)] : []),
    { id: 'path', tone: test.path ? 'ok' : 'warn', label: t('新会话将使用'), text: [pathText, reasonWords(test.reason)].filter(Boolean).join(' · '), hint: null, title: null },
  ];
}

export function windowWords(window: LimitWindow | null | undefined) {
  if (!window) return null;
  const mins = window.windowDurationMins, span = mins === null || mins === undefined ? null : mins >= 1440 ? t('{n} 天', { n: Math.round(mins / 1440) }) : mins >= 60 ? t('{n} 小时', { n: Math.round(mins / 60) }) : t('{n} 分钟', { n: mins });
  return { span, used: typeof window.usedPercent === 'number' ? `${Math.round(window.usedPercent)}%` : t('未知'), resets: window.resetsAtMs === null || window.resetsAtMs === undefined ? t('未知') : clockWords(window.resetsAtMs) };
}
