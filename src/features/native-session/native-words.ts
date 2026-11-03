// How the model's items and states read: the text an item shows (tolerant of the shapes the two runtimes give — a field that is absent is
// absent, never guessed) and the words for states, receipts, routes and money.
//
// The item content fields read here: messages, reasoning summaries and plans `text` (a string, or blocks with `text`; a reasoning summary
// may also give `summary`); the owner's message `clientMessageId`; commands `command` (string or list), `cwd`, `exitCode`, `durationMs`, `output`;
// file changes `changes[{ path, kind, diff }]` or `path`, `kind`, `diff`; tools `name` or `tool`, `server`, `input` or `arguments`, `result` or
// `output`. Quota windows are `{ usedPercent, windowDurationMins, resetsAtMs }` with `resetsAtMs` in milliseconds.
import { t } from '../../shared/i18n';
import type { LimitWindow } from './native-bridge.ts';
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

export function windowWords(window: LimitWindow | null | undefined) {
  if (!window) return null;
  const mins = window.windowDurationMins, span = mins === null || mins === undefined ? null : mins >= 1440 ? t('{n} 天', { n: Math.round(mins / 1440) }) : mins >= 60 ? t('{n} 小时', { n: Math.round(mins / 60) }) : t('{n} 分钟', { n: mins });
  return { span, used: typeof window.usedPercent === 'number' ? `${Math.round(window.usedPercent)}%` : t('未知'), resets: window.resetsAtMs === null || window.resetsAtMs === undefined ? t('未知') : clockWords(window.resetsAtMs) };
}
