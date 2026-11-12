// Codex's /status and /usage as result panels. The app-server's facts arrive in the send receipt's `local` field; a value main did not know is null and reads
// 未知 here. Pure: facts in, panel out.
import { t } from '../../shared/i18n';
import { array, compact, grouped, number, object, panelTitle, percentWords, readFailed, resetWords, share, unknown, word, type Panel, type PanelGroup, type Quota, type Row } from './native-panel.ts';
import { isCodexPermissions, type CodexPermissions } from '../../shared/codex-permissions.ts';
import { permissionName } from './native-composer.ts';

export type CodexFacts = {
  command: 'status' | 'usage';
  session: { model: string | null; effort: string | null; fast: boolean | null; cwd: string | null; sandbox: string | null; approval: string | null; permissions: CodexPermissions | null };
  account: { provider: string | null; kind: 'api' | 'subscription' | 'none' | 'unknown' };
  tokens: { total: number | null; input: number | null; output: number | null; cachedInput: number | null; reasoning: number | null; context: number | null; window: number | null };
  limits: { id: '5h' | 'week'; usedPercent: number | null; resetsAtMs: number | null }[];
  errors: { source: 'account' | 'limits'; reason: string }[];
};

// The facts out of a `local` field; anything that is not an answer to /status or /usage is null.
export function readCodexFacts(local: Record<string, unknown> | null): CodexFacts | null {
  if (!local || local.command !== 'status' && local.command !== 'usage') return null;
  const session = object(local.session), account = object(local.account), tokens = object(local.tokens);
  return {
    command: local.command as CodexFacts['command'],
    session: { model: word(session.model), effort: word(session.effort), fast: typeof session.fast === 'boolean' ? session.fast : null, cwd: word(session.cwd), sandbox: word(session.sandbox), approval: word(session.approval),
      permissions: isCodexPermissions(session.permissions) ? session.permissions : null },
    account: { provider: word(account.provider), kind: ['api', 'subscription', 'none'].includes(account.kind as string) ? account.kind as CodexFacts['account']['kind'] : 'unknown' },
    tokens: { total: number(tokens.total), input: number(tokens.input), output: number(tokens.output), cachedInput: number(tokens.cachedInput), reasoning: number(tokens.reasoning), context: number(tokens.context), window: number(tokens.window) },
    limits: (['5h', 'week'] as const).map(id => {
      const found = array(local.limits).map(object).find(row => row.id === id), used = found?.usedPercent;
      return { id, usedPercent: typeof used === 'number' && Number.isFinite(used) ? used : null, resetsAtMs: number(found?.resetsAtMs) };
    }),
    errors: array(local.errors).map(object).flatMap(row => (row.source === 'account' || row.source === 'limits') && word(row.reason) ? [{ source: row.source as CodexFacts['errors'][number]['source'], reason: row.reason as string }] : []),
  };
}

const failure = (facts: CodexFacts, source: 'account' | 'limits') => facts.errors.find(row => row.source === source)?.reason ?? null;
const approvalWord = (value: string) => ({ never: t('从不询问'), 'on-request': t('按需询问'), 'on-failure': t('失败时询问'), untrusted: t('不受信任时询问'), granular: t('细分审批') } as Record<string, string>)[value] ?? value;
const sandboxWord = (value: string) => ({ readOnly: t('只读'), workspaceWrite: t('工作区可写'), dangerFullAccess: t('完全访问'), externalSandbox: t('外部沙箱') } as Record<string, string>)[value] ?? value;
const accountWord = (kind: CodexFacts['account']['kind']) => kind === 'api' ? t('API 密钥') : kind === 'subscription' ? t('ChatGPT 订阅') : kind === 'none' ? t('未连接') : unknown();

type Window = Quota & { id: string; resetsAtMs: number | null };
// The two quota windows. A window at 100% is told as used up and says when it recovers; one below keeps its percent and reset time.
function windows(facts: CodexFacts, now: number): Window[] {
  const failed = failure(facts, 'limits');
  return facts.limits.map(window => {
    const percent = window.usedPercent === null ? null : Math.min(100, Math.max(0, window.usedPercent)), full = percent === 100;
    const time = window.resetsAtMs === null ? null : resetWords(window.resetsAtMs, now);
    const when = time === null ? percent === null ? '' : full ? t('恢复时间未知') : t('重置时间未知') : full ? t('恢复于 {time}', { time }) : t('重置于 {time}', { time });
    return { id: window.id, resetsAtMs: window.resetsAtMs, name: window.id === '5h' ? t('5 小时') : t('每周'), percent, full, when,
      used: percent !== null ? percentWords(Math.round(percent * 10) / 10) : failed ? readFailed(failed) : unknown() };
  });
}

// The first thing to know: the quota that is used up (the one that recovers last holds everything up), else a read that failed.
function alertOf(facts: CodexFacts, list: Window[], now: number): Panel['alert'] {
  const blocked = list.filter(window => window.full).sort((a, b) => (b.resetsAtMs ?? Infinity) - (a.resetsAtMs ?? Infinity))[0];
  if (blocked) return { strong: t('{name}额度已用完', { name: blocked.name }), text: blocked.resetsAtMs === null ? t('，恢复时间未知') : t('，{time} 恢复', { time: resetWords(blocked.resetsAtMs, now) }) };
  const limits = failure(facts, 'limits'), account = failure(facts, 'account');
  if (limits) return { strong: t('额度读取失败'), text: `（${limits}）` };
  return account ? { strong: t('账号读取失败'), text: `（${account}）` } : undefined;
}

const tokenRows = ({ tokens }: CodexFacts): Row[] => [
  { label: t('合计'), value: grouped(tokens.total) },
  { label: t('输入'), value: grouped(tokens.input), ...(tokens.cachedInput === null ? {} : { note: t('其中缓存 {value}', { value: grouped(tokens.cachedInput) }) }) },
  { label: t('输出'), value: grouped(tokens.output), ...(tokens.reasoning === null ? {} : { note: t('其中推理 {value}', { value: grouped(tokens.reasoning) }) }) },
];

export function codexPanel(local: Record<string, unknown> | null, now = Date.now()): Panel | null {
  const facts = readCodexFacts(local);
  if (!facts) return null;
  const list = windows(facts, now), { session, tokens, account } = facts, usage = facts.command === 'usage';
  const context = share(tokens.context, tokens.window);
  const accountFailed = failure(facts, 'account');
  const quota: PanelGroup = { kind: 'quota', title: t('额度'), quotas: (usage ? [...list].sort((a, b) => Number(b.full) - Number(a.full)) : list).map(({ id, resetsAtMs, ...rest }) => rest) };
  const contextRow: Row = { label: t('上下文'), value: tokens.window === null ? grouped(tokens.context) : `${compact(tokens.context)} / ${compact(tokens.window)}`, ...(context === null ? {} : { note: percentWords(Math.round(context)) }) };
  const base = { agent: 'codex' as const, title: panelTitle('codex', facts.command), command: `/${facts.command}`, alert: alertOf(facts, list, now), readAt: now };
  if (usage) return { ...base, groups: [quota, { kind: 'rows', title: t('本会话'), rows: [{ label: t('合计'), value: grouped(tokens.total) }, contextRow] }] };
  return { ...base,
    ...(tokens.context === null ? {} : { hero: { value: compact(tokens.context), unit: tokens.window === null ? undefined : `/ ${compact(tokens.window)}`,
      caption: context === null ? t('上下文') : t('上下文已用 {value}', { value: percentWords(Math.round(context)) }), percent: context } }),
    groups: [quota,
      { kind: 'rows', title: t('会话'), rows: [{ label: t('模型'), value: session.model ?? unknown() }, { label: t('思考强度'), value: session.effort ?? unknown() },
        { label: t('快速模式'), value: session.fast === null ? unknown() : session.fast ? t('开') : t('关') }, { label: t('工作目录'), value: session.cwd ?? unknown() }] },
      // The owner's choice for this session first (a worker's session has none), then what Codex applied.
      { kind: 'chips', title: t('权限'), chips: [...(session.permissions ? [{ text: t('方式：{value}', { value: permissionName(session.permissions) }) }] : []),
        { text: t('审批：{value}', { value: session.approval ? approvalWord(session.approval) : unknown() }) },
        { text: t('沙箱：{value}', { value: session.sandbox ? sandboxWord(session.sandbox) : unknown() }), warn: session.sandbox === 'dangerFullAccess' }] },
      { kind: 'rows', title: t('账号'), rows: [{ label: t('登录方式'), value: accountFailed ? readFailed(accountFailed) : accountWord(account.kind) },
        { label: t('模型服务'), value: account.provider ? account.provider === 'openai' ? 'OpenAI' : account.provider : unknown() }] },
      { kind: 'rows', title: t('本会话 token'), rows: tokenRows(facts) }] };
}
