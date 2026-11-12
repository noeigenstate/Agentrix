// How the model's items and states read: the text an item shows (tolerant of the shapes the two runtimes give — a field that is absent is
// absent, never guessed) and the words for states, receipts, routes and money.
//
// The item content fields read here: messages and plans `text` (a string, or blocks with `text`);
// the owner's message `clientMessageId` and `images`; commands `command` (string or list), `phrase` (main's few words for it), `cwd`, `exitCode`, `durationMs`, `output`;
// file changes `changes[{ path, kind, diff }]` or `path`, `kind`, `diff`; tools `name` or `tool`, `server`, `path`, `output` (or `result`), and `input` or `arguments`
// only to name a step by (never shown); an assistant picture `generated { path, prompt, copied, copyNote, deferred }` and `images`. Quota windows are `{ usedPercent, windowDurationMins, resetsAtMs }` with `resetsAtMs` in milliseconds.
import { t } from '../../shared/i18n';
import type { ClaudeFound } from '../../shared/types';
import type { ResultFacts } from '../reading/feed-parts';
import type { AgentConnection, ConnectionTest, LimitWindow, NativeAgent, SwitchState } from './native-bridge.ts';
import type { LimitNotice, NativeItem, Payload, TurnEnd } from './native-model.ts';

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
const list = (value: unknown): Payload[] => (Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object') as Payload[] : []);
const lines = (value: unknown) => (Array.isArray(value) ? value.map(entry => typeof entry === 'string' ? entry : (str((entry as Payload | null)?.text) ?? '')).filter(Boolean).join('\n') : (str(value) ?? ''));
// What a tool printed, as words: a text, or the text blocks of a list or of its `content`. Anything else (a picture, a structure) has no words here, and JSON is never made of it.
const printed = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) ? value.map(printed).filter(Boolean).join('\n')
  : value && typeof value === 'object' ? printed((value as Payload).text ?? (value as Payload).content) : '');
// The fields a tool's input names: Claude gives the input as a JSON text (cut short when large, then it names none), Codex as an object.
function inputFields(value: unknown): Payload {
  try { const found = typeof value === 'string' ? JSON.parse(value) : value; return found && typeof found === 'object' && !Array.isArray(found) ? found as Payload : {}; } catch { return {}; }
}
export const fieldOf = (fields: Payload, ...names: string[]) => names.map(name => fields[name]).find((value): value is string => typeof value === 'string' && value !== '') ?? '';

// ── Items ──
export const messageText = (item: NativeItem) => item.deltas.text || lines(item.content.text) || lines(item.content.content);
export const planText = (item: NativeItem) => item.deltas.plan || lines(item.content.text);
// The pictures an item carries (the owner's, or one the agent drew), as data the view can show; undefined when it carries none.
export function picturesOf(item: NativeItem) {
  const found = Array.isArray(item.content.images) ? item.content.images.filter((image): image is string => typeof image === 'string' && image !== '') : [];
  return found.length ? found : undefined;
}
// The picture the agent drew: its file, the prompt behind it and its copy in the project; absent without its file.
export function generatedOf(item: NativeItem) {
  const { path, prompt, copied, copyNote, deferred } = (item.content.generated ?? {}) as Payload;
  if (!str(path)) return null;
  return { path: str(path)!, prompt: str(prompt) ?? '', ...(str(copied) ? { copied: str(copied)! } : {}), ...(str(copyNote) ? { copyNote: str(copyNote)! } : {}), ...(deferred === true ? { deferred: true } : {}) };
}

export function commandOf(item: NativeItem) {
  const { command, phrase, cwd, exitCode, durationMs, output } = item.content;
  return {
    command: Array.isArray(command) ? command.join(' ') : (str(command) ?? ''), phrase: str(phrase), cwd: str(cwd),
    exitCode: typeof exitCode === 'number' ? exitCode : null, durationMs: typeof durationMs === 'number' ? durationMs : null, output: item.deltas.output || (str(output) ?? ''),
  };
}

export function fileChanges(item: NativeItem) {
  const found = list(item.content.changes).map(change => ({ path: str(change.path) ?? '', kind: str(change.kind), diff: str(change.diff) ?? '' }));
  return found.length ? found : [{ path: str(item.content.path) ?? '', kind: str(item.content.kind), diff: str(item.content.diff) ?? '' }];
}

export function toolOf(item: NativeItem) {
  const { name, tool, server, input, arguments: args, result, output, path } = item.content;
  return { name: str(name) ?? str(tool) ?? t('工具'), server: str(server), fields: inputFields(input ?? args), path: str(path), result: printed(output) || printed(result) };
}

// The mark on a step: running turns, done ticks, failed crosses; a status the item does not give (or one we do not know) has no mark. A step that was
// cut off (the provider says interrupted), or that still runs when its turn is over (settled), is interrupted: it is never drawn as done.
// A step the provider settled as "unknown" (a frame was lost, or a "!" command's result is not certain) is neither done nor failed: its mark is a question.
export type StepMark = 'running' | 'done' | 'failed' | 'interrupted' | 'unknown' | null;
export function itemState(item: NativeItem, settled = false): StepMark {
  const status = item.status?.toLowerCase() ?? '';
  if (status === 'unknown') return 'unknown';
  if (/^(running|in[_ -]?progress|started|pending|active)$/.test(status)) return settled ? 'interrupted' : 'running';
  if (/^(completed?|done|success|succeeded)$/.test(status)) return 'done';
  if (/^(interrupted|cancell?ed|aborted)$/.test(status)) return 'interrupted';
  return /^(failed|error|errored)$/.test(status) ? 'failed' : null;
}

// ── States ──
// The word for a turn that failed with no message of its own.
export const turnFailed = () => t('本轮出错');

const RECEIPT_WORDS: Record<string, string> = { queued: '已排队', delivered: '已送达', consumed: '已被读取', rejected: '未送达', unknown: '送达状态未知' };
export const receiptWord = (status: string | null | undefined) => (status && RECEIPT_WORDS[status] ? t(RECEIPT_WORDS[status]) : null);

// Why a worker's final refusal happened, by the code main gives; the code itself is never shown.
const REJECTION_WORDS: Record<string, string> = {
  worker_ended_without_resume: '工作者已结束，消息未能继续处理。', worker_ended_before_read: '工作者结束前未能读取消息，恢复一次后仍未处理。',
};
// Where a message to a worker stands: its status and, for a refusal, why.
export type Receipt = { status: string; reason?: string | null };
// A receipt in words. A refusal we know the reason of says that sentence; any other says 未送达 with the sentence main wrote, never a machine code.
export function receiptLine({ status, reason }: Receipt) {
  if (status !== 'rejected') return receiptWord(status) ?? t('送达状态未知');
  if (reason && Object.hasOwn(REJECTION_WORDS, reason)) return t(REJECTION_WORDS[reason]);
  return `${t('未送达')} · ${reason && !CODE.test(reason) ? reason : t('工作者未提供原因。')}`;
}

// The route codes the main process gives for a switch; one it does not know is shown as given, never hidden.
const REASON_WORDS: Record<string, string> = {
  budget_exhausted: '本月 API 预算已用完', credits_exhausted: 'API 额度已用完', rate_limited: 'API 被限流', no_key: '还没有保存 API key',
  native_cli_required: '未找到原生 Claude Code，无法通过 API 运行', native_cli_unverified: 'Claude Code 检查没有通过，无法通过 API 运行',
  billing_identity_mismatch: 'Claude Code 没有使用这个密钥', billing_unconfirmed: '无法确认 Claude Code 的计费来源',
  settings: '按设置运行', user: '你选择了终端',
  codex_cli_required: '未找到 Codex 命令行，无法使用原生模式', unsupported_codex_version: '这个 Codex 版本不支持原生模式', terminal_selected: '按设置使用终端',
  cli_split_versions: '终端和原生用的 Claude Code 版本不同',
  terminal_agent_exited: 'Claude Code 在终端里启动后就退出了', terminal_start_failed: '终端里的 Claude Code 没有启动成功',
};

// A folder for a single line: short ones whole, long ones as … and their last two parts (the whole path goes in a tooltip).
export function shortPath(path: string, max = 32) {
  if (path.length <= max) return path;
  const separator = path.includes('\\') ? '\\' : '/', parts = path.split(/[\\/]+/).filter(Boolean);
  return `…${separator}${parts.slice(-2).join(separator)}`;
}
// A reason in words: a code we know says it; a sentence main wrote for the owner is shown as it is; a code we do not know is not shown, and neither is no reason.
const CODE = /^[a-z][a-z0-9_.-]*$/i;
export const reasonWords = (reason: string | null | undefined) => (!reason ? null : REASON_WORDS[reason] ? t(REASON_WORDS[reason]) : CODE.test(reason) ? null : reason);

export const routeWord = (route: string | null | undefined) => (route === 'api' ? 'API' : route === 'terminal' ? t('终端') : route === 'native' ? t('原生模式') : route === 'subscription' ? t('订阅') : t('未知'));

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

// What a change that has ended tells, by the outcome main gives (never by whether it left a reason): a failed one leaves the session where it was and
// says so with main's reason and, when main names what stopped it, that cause (in words when we know the code, else the code itself, so a failure can
// be told apart and reported); one that switched may still carry a warning (the old process did not exit cleanly), and a restored or stopped one says its
// reason. A change still under way (but rolling back) is failing; an ended one that gives no outcome says nothing. null when there is nothing to tell.
export function switchNote(state: SwitchState | null | undefined) {
  if (!state) return null;
  const outcome = state.phase === 'rolling-back' ? state.outcome ?? 'failed' : state.phase === 'stable' ? state.outcome : undefined, reason = reasonWords(state.reason);
  if (outcome === 'failed') return [t('没有切换成功，仍使用 {path}', { path: routeWord(state.current) }), reason, reasonWords(state.cause) ?? state.cause].filter(Boolean).join(' · ');
  return outcome === 'switched' || outcome === 'restored' || outcome === 'stopped' ? reason : null;
}

// ── How a turn ended ──
// A sentence main wrote for the owner, translated like any interface text (one without an English line stays as written); none gives none.
export const sentence = (message: string | null | undefined) => (message ? t(message) : null);
const exact = (value: number) => value.toLocaleString('en-US');

// A turn's tokens in words. Claude counts the cached and cache-written input apart from `input`; Codex's `input` already holds its cache, and reasoning is part of
// the output: neither is added twice. A turn that counted nothing says nothing.
function tokenWords(tokens: NonNullable<TurnEnd['tokens']>, provider: NativeAgent) {
  const input = tokens.input === null ? null : provider === 'claude' ? tokens.input + (tokens.cachedInput ?? 0) + (tokens.cacheWrite ?? 0) : tokens.input;
  if (!input && !tokens.output) return undefined;
  return [input !== null && t('输入 {count}', { count: exact(input) }), tokens.output !== null && t('输出 {count}', { count: exact(tokens.output) })].filter(Boolean).join(' · ');
}

// The facts the reading view's result row shows for the turn that just ended, from what turn.completed carried: the duration its provider measured, this turn's
// spend (an estimate unless the provider says otherwise) and tokens, and for a turn that did not complete the sentence main wrote for it. What it did not give is
// absent — no duration, spend or count is ever 0 — and Codex gives no spend. The turn's tokens are not the conversation's running total, so the two never add.
export function turnFacts(end: TurnEnd | null | undefined, provider: NativeAgent, completed: boolean): ResultFacts | undefined {
  if (!end) return undefined;
  const facts: ResultFacts = {}, spend = end.costUsdMicros ? money(end.costUsdMicros) : null, tokens = end.tokens ? tokenWords(end.tokens, provider) : undefined;
  if (end.durationMs) facts.durationMs = end.durationMs;
  if (spend) facts.spend = end.costEstimated === false ? spend : t('约 {amount}', { amount: spend });
  if (tokens) facts.tokens = tokens;
  if (!completed && end.message) facts.message = t(end.message);
  return Object.keys(facts).length ? facts : undefined;
}

// ── The provider's notice that a limit was reached ──
// The sentence main wrote, without the recovery time it appends (the time is told from resetsAtMs in the window's own clock, or not at all), and when the
// provider says it recovers. A notice whose recovery time has passed is over.
export function noticeWords(notice: LimitNotice | null | undefined, now = Date.now()) {
  if (!notice || typeof notice.resetsAtMs === 'number' && notice.resetsAtMs <= now) return null;
  return { text: t(notice.message), resets: typeof notice.resetsAtMs === 'number' ? t('约 {time} 恢复', { time: clockWords(notice.resetsAtMs, now) }) : null };
}

// The one address the notice may send the owner to: the console's billing page. A notice naming any other address gets no button.
export const BILLING_URL = 'https://platform.claude.com/settings/billing';
export const consoleCheck = (notice: LimitNotice | null | undefined) => notice?.action === 'check-console' && notice.url === BILLING_URL;
// Whether the notice's sentence is already in the conversation: in the turn's error line or in the agent's own reply to the last message (as the provider wrote it
// or translated). The sentence is said once; the notice then only adds when it recovers and the console button.
export const noticeTold = (notice: LimitNotice | null | undefined, lines: readonly (string | null | undefined)[]) =>
  !!notice && lines.some(line => !!line && (line.trim() === notice.message || line.trim() === t(notice.message)));

// What the owner is told before choosing: a switch ends background tasks. Unknown is not none, so no count is guessed.
export const backgroundWords = (background: SwitchState['background']) => (background.known && typeof background.count === 'number'
  ? t('切换会结束 {count} 个后台任务。', { count: background.count }) : t('切换会结束后台任务；现在还不知道有几个在运行。'));

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
// `active: false` is an account that is signed in while this agent has no main session. A sub-agent may still be running on it, so the row names the plan and says nothing about sessions; only 已连接 waits for a session to back it.
export function connectionWord(agent: NativeAgent, connection: (AgentConnection) | null | undefined) {
  const word = connection?.active === false && connection.kind === 'api' ? 'API' : connection ? CONNECTION_WORDS[agent][connection.kind] : undefined;
  return { text: word ? t(word) : t('未知'), source: connection?.source || null };
}

// The lines of a connection test, each with a tone (ok, warn, bad) the view marks with a symbol as well as colour, and a next step for
// what failed. The key itself is never in a result; a detail is one plain sentence from the main process.
const KEY_WORDS: Record<string, string> = { ok: '有效', missing: '没有保存密钥', invalid: '无效', forbidden: '无权限', rate_limited: '被限流', unreachable: '无法连接', error: '检查出错' };
const KEY_HINTS: Record<string, string> = {
  missing: '先保存 API key，再测试。', invalid: '请检查密钥是否完整，或是否已在 Anthropic 控制台被撤销。', forbidden: '这个密钥没有权限，请到 Anthropic 控制台检查它的权限，或检查网络和代理（所在地区可能不受支持）。',
  rate_limited: '请求太频繁，稍后再测试。', unreachable: '请检查网络或代理设置后重试。', error: '请稍后重试。',
};
const MODELS_SHOWN = 5;
export type TestLine = { id: 'key' | 'models' | 'cli' | 'billing' | 'path'; tone: 'ok' | 'warn' | 'bad'; label: string; text: string; hint: string | null; title: string | null };
const BILLING_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key', 'none', 'user', 'project', 'org', 'temporary', 'oauth']);
const BILLING_TOKENS = new Set(['apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN']);
const BILLING_NAMES = new Set([...BILLING_SOURCES, ...BILLING_TOKENS, 'claude.ai', 'CLAUDE_CODE_OAUTH_TOKEN']);

// A mismatch names what Claude Code reported in place of the key: the token source when that is what the requests
// carry, otherwise its key source; only a value Claude Code is known to report is shown, any other reads 未知值.
// The hint says why and what to check (main's sentence). What that means for new sessions is the path line's to say,
// except that a setting allowing no terminal starts none.
function billingLine(test: ConnectionTest): TestLine {
  const { status, source, reported, detail } = test.billing;
  const ok = status === 'ok' && source === 'ANTHROPIC_API_KEY', mismatch = status === 'mismatch';
  const raw = reported?.tokenSource && BILLING_TOKENS.has(reported.tokenSource) ? reported.tokenSource
    : reported?.apiKeySource ?? (source !== 'ANTHROPIC_API_KEY' ? source : null);
  const named = raw == null ? null : BILLING_NAMES.has(raw) ? raw : t('未知值');
  const why = detail ? t(detail.text, detail.values) : mismatch ? t('Claude Code 没有使用这个密钥。') : t('无法确认 Claude Code 的计费来源，请重试。');
  return { id: 'billing', label: t('计费来源'), tone: ok ? 'ok' : mismatch ? 'bad' : 'warn',
    text: ok ? source : mismatch && named ? named : t('未知'), title: null,
    hint: ok ? null : mismatch && !test.path ? `${why} ${t('当前设置不允许启动新会话。')}` : why };
}

// Where Claude Code was found (main's ClaudeVia); a value this view does not know is shown as given.
const VIA_WORDS: Record<string, string> = {
  path: 'PATH', npm: 'npm 全局安装', 'platform-package': 'npm 平台包', 'local-bin': '官方安装器（~/.local/bin）', 'claude-local': '旧版本地安装（~/.claude/local）',
  winget: 'WinGet', 'registry-path': '系统 PATH（注册表）', system: '系统目录',
};
export const viaWords = (via: string) => (VIA_WORDS[via] ? t(VIA_WORDS[via]) : via);
// One install in a sentence: its version (未知 when it has none), where it came from and its file.
const foundWords = ({ version, via, fileShown }: Partial<ClaudeFound>) => [version ? t('版本 {version}', { version }) : t('版本未知'), via && t('来自 {via}', { via: viaWords(via) }), fileShown].filter(Boolean).join(' · ');

// The official installer's command. Main writes the package path with its own separators, so a backslash means Windows.
const installCommand = (dir: string) => dir.includes('\\')
  ? t('在 PowerShell 运行 irm https://claude.ai/install.ps1 | iex') : t('在终端运行 curl -fsSL https://claude.ai/install.sh | bash');

// Why a CLI that may be installed did not pass its check; `not_found` (or an older main that gives no reason) asks for
// an install and says where main looked, or why the npm package it found cannot run.
function cliHint({ reason, found: file, error, elapsedMs, required, pathFolders, searched, incomplete }: ConnectionTest['cli']) {
  if (incomplete) return t('找到用 npm 安装的 Claude Code（{dir}），但里面没有原生程序：npm 跳过了它的安装步骤（npm 12 默认跳过，--ignore-scripts 或 --omit=optional 也会）。请改用官方安装器安装原生版：{command}，装好后重新测试连接。',
    { dir: incomplete, command: installCommand(incomplete) });
  if (!reason || reason === 'not_found') {
    const install = t('请安装 Claude Code（需要 ≥ {required}）。', { required }), places = searched?.join('、');
    if (!places) return install;
    return `${install} ${typeof pathFolders === 'number' ? t('已查找 PATH 里的 {n} 个目录，以及 {places}。', { n: pathFolders, places }) : t('已查找 {places}。', { places })}`;
  }
  if (!file) return t('检查 Claude Code 时出错，请重试。');
  if (reason === 'timeout') return typeof elapsedMs === 'number'
    ? t('找到 {file}，但运行 claude --version {seconds} 秒后仍没有结束，请稍后重试。', { file, seconds: Math.round(elapsedMs / 1000) })
    : t('找到 {file}，但运行 claude --version 超时，请稍后重试。', { file });
  const what = reason === 'unreadable' ? t('找到 {file}，但它没有输出版本号。', { file })
    : error ? t('找到 {file}，但无法运行它（{error}）。', { file, error }) : t('找到 {file}，但无法运行它。', { file });
  return `${what} ${t('请重新安装 Claude Code，或检查安全软件是否拦截。')}`;
}
const anthropicSays = (error: string | null | undefined) => error ? t('Anthropic：{error}', { error }) : null;

export function connectionLines(test: ConnectionTest): TestLine[] {
  const { key, models, cli } = test, keyTone = key.status === 'ok' ? 'ok' : key.status === 'rate_limited' ? 'warn' : 'bad';
  const latency = key.status === 'ok' && typeof key.latencyMs === 'number' ? ` · ${Math.round(key.latencyMs)} ms` : '';
  const keyHint = key.status === 'ok' ? null
    : [t(KEY_HINTS[key.status] ?? KEY_HINTS.error), key.status === 'error' ? key.detail : null, anthropicSays(key.error)].filter(Boolean).join(' ');
  const shown = models?.slice(0, MODELS_SHOWN) ?? [];
  const modelText = test.modelsForbidden ? t('无列表权限') : !models ? t('未知') : !models.length ? t('没有可用模型')
    : shown.join('、') + (models.length > shown.length ? ` ${t('等 {n} 个', { n: models.length })}` : '');
  const modelHint = test.modelsForbidden ? [t('这个密钥不能读取模型列表，但能正常通过验证。'),
    test.unavailableModel ? t('模型 {model} 对这个密钥不可用。', { model: test.unavailableModel }) : null, anthropicSays(test.modelsError)].filter(Boolean).join(' ') : null;
  const required = cli.required, version = cli.version, unverified = cli.status === 'missing' && !!cli.reason && cli.reason !== 'not_found';
  const cliText = cli.status === 'ok' ? (version ? t('版本 {version}（满足 ≥ {required}）', { version, required }) : t('已找到（需要 ≥ {required}）', { required }))
    + (cli.via ? ` · ${t('来自 {via}', { via: viaWords(cli.via) })}` : '')
    : unverified ? t('检查失败') : cli.status === 'missing' ? cli.incomplete ? t('安装不完整') : t('未找到')
      : version ? t('版本 {version} 过低（需要 ≥ {required}）', { version, required }) : t('版本过低（需要 ≥ {required}）', { required });
  const split = cli.status === 'ok' && cli.notice === 'cli_split_versions' ? cli.split?.terminal ?? null : null;
  const pathText = test.path === 'api' ? 'API' : test.path === 'terminal' ? t('终端（订阅）') : t('未知');
  return [
    { id: 'key', tone: keyTone, label: t('密钥'), text: (KEY_WORDS[key.status] ? t(KEY_WORDS[key.status]) : t('检查出错')) + latency, hint: keyHint, title: key.detail },
    { id: 'models', tone: models?.length ? 'ok' : 'warn', label: t('可用模型'), text: modelText, hint: modelHint, title: models?.join('\n') || null },
    { id: 'cli', tone: cli.status !== 'ok' ? 'bad' : split ? 'warn' : 'ok', label: 'Claude Code', text: cliText, title: cli.found ?? cli.incomplete ?? cli.fileShown ?? null,
      hint: cli.status === 'missing' ? cliHint(cli) : cli.status === 'too_old' ? t('请升级 Claude Code。')
        : split ? t('{reason}。终端：{terminal}；原生：{native}。原生需要 ≥ {required}。', { reason: t(REASON_WORDS.cli_split_versions), terminal: foundWords(split), native: foundWords(cli), required }) : cli.fileShown ?? null },
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
