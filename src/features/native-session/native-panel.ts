// The result panel of a command that only shows information (/status, /usage, /context, /cost): one structure the window draws, whatever the command or
// the provider. A command supplies facts and a builder turns them into groups of five kinds; nothing here is a message of the conversation. A value main did
// not know is 未知 in the window — never zero, never a guess. Pure: facts in, structure and plain text out.
import { currentLanguage, t } from '../../shared/i18n';

export type PanelAgent = 'claude' | 'codex';
export type PanelCommand = 'status' | 'usage' | 'context' | 'cost';
export type Row = { label: string; value: string; note?: string };
export type Quota = { name: string; percent: number | null; used: string; full: boolean; when: string };
export type Segment = { label: string; value: string; share: number };
export type Chip = { text: string; warn?: boolean };
export type Suggestion = { command: string; description: string };
// The five kinds of content: a list of rows, chips, quota bars, a stacked bar with its legend, and commands the owner may pick.
export type PanelGroup =
  | { kind: 'rows'; title?: string; rows: Row[] }
  | { kind: 'chips'; title?: string; chips: Chip[] }
  | { kind: 'quota'; title?: string; quotas: Quota[] }
  | { kind: 'composition'; title?: string; segments: Segment[] }
  | { kind: 'suggest'; title?: string; items: Suggestion[] };
export type Panel = {
  agent: PanelAgent; title: string; command: string;
  // Only when something needs to be known first: a quota used up, a read that failed. `strong` is the part told in the failure colour.
  alert?: { strong: string; text: string };
  // The one number the command is about, with the bar under it (percent null: no bar).
  hero?: { value: string; unit?: string; caption?: string; percent: number | null };
  groups: PanelGroup[]; readAt: number;
};
// What the window shows: asking, answered, or failed with the reason. `agent` and `command` are known before any answer, so the header is too.
export type PanelState = { agent: PanelAgent; command: PanelCommand } & ({ state: 'loading' } | { state: 'ready'; panel: Panel } | { state: 'failed'; error: string });

// Codex answers /status and /usage only; Claude answers all four.
export const panelTitle = (agent: PanelAgent, command: PanelCommand) => agent === 'codex' ? command === 'usage' ? t('Codex 额度') : t('Codex 状态')
  : command === 'usage' ? t('Claude 用量') : command === 'context' ? t('上下文用量') : command === 'cost' ? t('本会话花费') : t('Claude 状态');
export const unknown = () => t('未知');
export const readFailed = (reason: string) => t('读取失败（{reason}）', { reason });

export const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const word = (value: unknown) => typeof value === 'string' && value ? value : null;
export const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown) => Array.isArray(value) ? value : [];

const trim = (value: number) => String(Math.round(value * 10) / 10);
// 32,803 reads 32.8k and 1,000,000 reads 1M; the exact count is the tooltip's and the copy's.
export const compact = (value: number | null) => value === null ? unknown() : value >= 1e6 ? `${trim(value / 1e6)}M` : value >= 1e3 ? `${trim(value / 1e3)}k` : String(value);
export const grouped = (value: number | null) => value === null ? unknown() : value.toLocaleString('en-US');
export const percentWords = (value: number) => `${trim(value)}%`;
export const dollars = (micros: number | null) => micros === null ? unknown() : micros > 0 && micros < 5000 ? '<$0.01' : `$${(micros / 1e6).toFixed(2)}`;
export function duration(ms: number | null) {
  if (ms === null) return unknown();
  const seconds = Math.round(ms / 1000), minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return t('{hours} 小时 {minutes} 分', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return minutes ? t('{minutes} 分 {seconds} 秒', { minutes, seconds: seconds % 60 }) : t('{seconds} 秒', { seconds });
}
// The share of a total as a percent of a bar, kept inside 0..100.
export const share = (part: number | null, total: number | null) => part === null || !total ? null : Math.min(100, Math.max(0, part * 100 / total));

// When a quota resets or recovers: "今天 19:22" for today, else "11月13日 周四 16:26" (English "Thu, Nov 13, 16:26"). The parts come from Intl in the
// interface language, so no month or weekday table is kept here; only the order differs by language.
export function resetWords(at: number, now = Date.now()) {
  const english = currentLanguage() === 'en', date = new Date(at);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', options).format(date);
  const time = part({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (date.toDateString() === new Date(now).toDateString()) return t('今天 {time}', { time });
  const day = part({ month: 'short', day: 'numeric' }), weekday = part({ weekday: 'short' });
  return english ? `${weekday}, ${day}, ${time}` : `${day} ${weekday} ${time}`;
}

export const readTime =(at: number) => t('{time} 读取', { time: new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) });

// The panel as plain text, for "copy all": a title line, the alert, the hero, then each group under its title, one "label  value" row per line.
export function panelText(panel: Panel): string {
  const lines = [`${panel.title} ${panel.command}`];
  if (panel.alert) lines.push(panel.alert.strong + panel.alert.text);
  if (panel.hero) lines.push([panel.hero.value, panel.hero.unit, panel.hero.caption].filter(Boolean).join(' '));
  for (const group of panel.groups) {
    lines.push('', ...(group.title ? [group.title] : []));
    if (group.kind === 'rows') lines.push(...group.rows.map(row => `${row.label}  ${row.value}${row.note ? ` ${row.note}` : ''}`));
    else if (group.kind === 'chips') lines.push(group.chips.map(chip => chip.text).join(' / '));
    else if (group.kind === 'quota') lines.push(...group.quotas.map(quota => `${quota.name}  ${quota.used}  ${quota.when}`));
    else if (group.kind === 'composition') lines.push(...group.segments.map(segment => `${segment.label}  ${segment.value}`));
    else lines.push(...group.items.map(item => `${item.command}  ${item.description}`));
  }
  lines.push('', readTime(panel.readAt));
  return lines.join('\n');
}

// The window's answer to a send: main's `local` field, read tolerantly; null when the receipt answers nothing.
export const localOf = (receipt: unknown) => {
  const local = object(object(receipt).local);
  return ['status', 'usage', 'context', 'cost'].includes(local.command as string) ? local : null;
};
