// Claude's /context, /cost, /status and /usage as result panels. The facts are what the SDK and this session already hold, in the send receipt's `local` field;
// a value that is not there reads 未知 or is left out — nothing here is estimated. Pure: facts in, panel out.
import { t } from '../../shared/i18n';
import { array, compact, dollars, duration, grouped, number, object, panelTitle, percentWords, resetWords, share, unknown, word, type Panel, type PanelCommand, type PanelGroup, type Quota, type Row, type Segment } from './native-panel.ts';

type Tokens = { name: string; tokens: number };
const named = (value: unknown): Tokens[] => array(value).map(object).flatMap(row => word(row.name) && number(row.tokens) !== null ? [{ name: row.name as string, tokens: row.tokens as number }] : []);
const money = (value: unknown) => number(value);

type Category = { id: string | null; name: string; tokens: number; kind: string | null };
const categories = (value: unknown): Category[] => array(value).map(object).flatMap(row => word(row.name) && number(row.tokens) !== null
  ? [{ id: word(row.id), name: row.name as string, tokens: row.tokens as number, kind: word(row.kind) }] : []);
// A category in the owner's words by its id; with no id, or one not known, the SDK's own name is shown as it came.
const categoryWord = ({ id, name }: Category) => (id ? ({ 'system-prompt': t('系统提示'), 'system-tools': t('工具定义'), 'mcp-tools': t('MCP 工具'), 'custom-agents': t('自定义 Agent'),
  'memory-files': t('记忆与 CLAUDE.md'), skills: t('技能'), messages: t('对话消息') } as Record<string, string>)[id.toLowerCase().replace(/[^a-z0-9]+/g, '-')] : undefined) ?? name;

function contextHero(context: Record<string, unknown>, caption?: string): Panel['hero'] {
  const tokens = number(context.tokens), window = number(context.window), used = share(tokens, window);
  if (tokens === null) return undefined;
  const compactAt = number(context.autoCompactThreshold), at = share(compactAt, window);
  const compacting = context.autoCompact === true && at !== null ? t('自动压缩在 {value} 触发', { value: percentWords(Math.round(at)) }) : context.autoCompact === false ? t('自动压缩已关闭') : null;
  return { value: compact(tokens), unit: window === null ? undefined : `/ ${compact(window)}`, percent: used,
    caption: caption ?? [used === null ? t('上下文') : t('已用 {value}', { value: percentWords(Math.round(used)) }), compacting].filter(Boolean).join(' · ') };
}

// The three biggest parts of the used context get a colour each; the rest is one more part.
function composition(context: Record<string, unknown>): Segment[] {
  // Only what the SDK calls used context counts; free space, the compaction buffer and deferred parts are not in the bar.
  const parts = categories(context.categories).filter(row => row.kind === 'used' && row.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const total = parts.reduce((sum, row) => sum + row.tokens, 0), rest = parts.slice(3).reduce((sum, row) => sum + row.tokens, 0);
  const shown = [...parts.slice(0, 3).map(row => ({ label: categoryWord(row), tokens: row.tokens })), ...(rest ? [{ label: t('其他'), tokens: rest }] : [])];
  return shown.map(row => ({ label: row.label, value: compact(row.tokens), share: row.tokens / total * 100 }));
}

function context(local: Record<string, unknown>): { hero: Panel['hero']; groups: PanelGroup[] } {
  const facts = object(local.context), segments = composition(facts);
  const biggest = [[t('MCP 工具'), named(facts.mcp)[0]], [t('记忆文件'), named(facts.memory)[0]], [t('技能'), named(facts.skills)[0]]] as const;
  const rows = biggest.flatMap(([label, row]): Row[] => row ? [{ label, value: row.name, note: compact(row.tokens) }] : []);
  return { hero: contextHero(facts), groups: [
    ...(segments.length ? [{ kind: 'composition', title: t('已用部分的构成'), segments } as const] : []),
    ...(rows.length ? [{ kind: 'rows', title: t('占用最多的'), rows } as const] : []),
  ] };
}

function cost(local: Record<string, unknown>): { hero: Panel['hero']; groups: PanelGroup[] } {
  const total = money(local.costUsdMicros), month = object(local.month), spent = money(month.spentMicros), budget = typeof month.budgetUsd === 'number' ? month.budgetUsd : null;
  const caption = [t('API 计费'), spent === null ? null : t('本月已用 {value}', { value: dollars(spent) + (budget === null ? '' : ` / $${budget}`) })].filter(Boolean).join(' · ');
  const times = [{ label: t('总用时'), value: number(local.durationMs) }, { label: t('API 用时'), value: number(local.apiDurationMs) }].filter(row => row.value !== null);
  const models = array(local.models).map(object).flatMap((row): Row[] => word(row.model) ? [{ label: row.model as string, value: dollars(money(row.costUsdMicros)),
    note: [number(row.input) === null ? null : t('输入 {value}', { value: compact(number(row.input)) }), number(row.output) === null ? null : t('输出 {value}', { value: compact(number(row.output)) })].filter(Boolean).join(' · ') || undefined }] : []);
  return { hero: { value: dollars(total), caption, percent: share(spent, budget === null ? null : budget * 1e6) }, groups: [
    ...(times.length ? [{ kind: 'rows', title: t('用时（本次打开以来）'), rows: times.map(row => ({ label: row.label, value: duration(row.value) })) } as const] : []),
    ...(models.length ? [{ kind: 'rows', title: t('按模型'), rows: models } as const] : []),
  ] };
}

const connectionWord = (kind: unknown) => kind === 'api' ? t('API 密钥') : kind === 'none' ? t('未连接') : unknown();

function status(local: Record<string, unknown>): { hero: Panel['hero']; groups: PanelGroup[]; alert?: Panel['alert'] } {
  const facts = object(local.context), session = object(local.session), mcp = array(session.mcp).map(object).filter(row => word(row.name));
  const failed = array(local.errors).map(object).find(row => row.source === 'context' && word(row.reason));
  const row = (label: string, value: unknown) => ({ label, value: word(value) ?? unknown() });
  const optional = (label: string, value: unknown): Row[] => word(value) ? [{ label, value: value as string }] : [];
  return { hero: contextHero(facts), alert: failed ? { strong: t('上下文读取失败'), text: `（${failed.reason}）` } : undefined, groups: [
    { kind: 'rows', title: t('会话'), rows: [row(t('模型'), word(session.model) ?? word(facts.model)), row(t('思考强度'), session.effort), row(t('工作目录'), session.cwd), row(t('会话 ID'), session.sessionId),
      ...optional(t('Claude Code 版本'), session.version), ...optional(t('权限模式'), session.permission)] },
    { kind: 'rows', title: t('账号'), rows: [{ label: t('登录方式'), value: connectionWord(object(local.account).kind) }] },
    ...(mcp.length ? [{ kind: 'rows', title: t('MCP 服务'), rows: mcp.map(server => ({ label: server.name as string, value: word(server.status) ?? unknown() })) } as const] : []),
  ] };
}

const NOTICES: Record<string, () => string> = { credits_required: () => t('API 余额不足'), spend_limit: () => t('API 用量已达上限'), rate_limited: () => t('API 请求受到限流') };
const windowName = (id: string) => id === 'five_hour' ? t('5 小时') : id === 'seven_day' ? t('每周') : id;

function usage(local: Record<string, unknown>, now: number): { hero: Panel['hero']; groups: PanelGroup[]; alert?: Panel['alert'] } {
  const month = object(local.month), spent = money(month.spentMicros), budget = typeof month.budgetUsd === 'number' ? month.budgetUsd : null, notice = object(local.notice);
  const windows = array(local.limits).map(object).flatMap((row): (Quota & { resetsAtMs: number | null })[] => {
    const raw = typeof row.usedPercent === 'number' && Number.isFinite(row.usedPercent) ? row.usedPercent : null, percent = raw === null ? null : Math.min(100, Math.max(0, raw)), full = percent === 100;
    const at = number(row.resetsAtMs), time = at === null ? null : resetWords(at, now);
    return word(row.id) ? [{ name: windowName(row.id as string), percent, full, resetsAtMs: at, used: percent === null ? unknown() : percentWords(Math.round(percent * 10) / 10),
      when: time === null ? '' : full ? t('恢复于 {time}', { time }) : t('重置于 {time}', { time }) }] : [];
  });
  const blocked = windows.filter(row => row.full).sort((a, b) => (b.resetsAtMs ?? Infinity) - (a.resetsAtMs ?? Infinity))[0], told = NOTICES[word(notice.code) ?? '']?.(), at = number(notice.resetsAtMs);
  const alert = told ? { strong: told, text: at === null ? '' : t('，{time} 恢复', { time: resetWords(at, now) }) }
    : blocked ? { strong: t('{name}额度已用完', { name: blocked.name }), text: blocked.resetsAtMs === null ? t('，恢复时间未知') : t('，{time} 恢复', { time: resetWords(blocked.resetsAtMs, now) }) } : undefined;
  const tokens = object(local.tokens), counts = [[t('输入'), tokens.input], [t('输出'), tokens.output], [t('缓存读取'), tokens.cacheRead], [t('缓存写入'), tokens.cacheWrite]] as const;
  const used = counts.flatMap(([label, value]): Row[] => number(value) === null ? [] : [{ label, value: grouped(number(value)) }]);
  return { alert, hero: { value: dollars(spent), unit: budget === null ? undefined : `/ $${budget}`, caption: t('本月 API 花费'), percent: share(spent, budget === null ? null : budget * 1e6) }, groups: [
    ...(windows.length ? [{ kind: 'quota', title: t('用量限额'), quotas: windows.map(({ resetsAtMs, ...rest }) => rest) } as const] : []),
    { kind: 'rows', title: t('花费'), rows: [{ label: t('今天'), value: dollars(money(object(local.today).spentMicros)) }, { label: t('本月'), value: dollars(spent) }] },
    ...(used.length ? [{ kind: 'rows', title: t('本会话 token'), rows: used } as const] : []),
  ] };
}

// The panel of a Claude answer; null when the receipt is none (a context the SDK did not give is the caller's failure to tell).
export function claudePanel(local: Record<string, unknown> | null, now = Date.now()): Panel | null {
  const command = local?.command as PanelCommand | undefined;
  if (!local || !command) return null;
  if (command === 'context' && !Object.keys(object(local.context)).length) return null;
  const built = command === 'context' ? context(local) : command === 'cost' ? cost(local) : command === 'usage' ? usage(local, now) : status(local);
  return { agent: 'claude', title: panelTitle('claude', command), command: `/${command}`, ...built, readAt: now };
}
