import type { Project, SkillInfo, SkillVersion } from '../../shared/types';
import { currentLanguage, t } from '../../shared/i18n';
import { relativeTime } from '../../shared/time';

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };

// What the page shows of a skill: a built-in's Chinese title and summary go through translation, a user's own words stay as written.
export const skillTitle = (skill: SkillInfo) => skill.source === 'builtin' ? t(skill.title) : skill.title;
export const skillSummary = (skill: SkillInfo) => skill.source === 'builtin' ? t(skill.summary) : skill.summary;

// The skill's folder name: the id follows the name sent when saving, which may differ from the SKILL.md front matter.
export const folderName = (skill: SkillInfo) => skill.path.split(/[\\/]/).at(-2) || skill.name;

// The two newest versions, oldest first: the pair the 变更 tab compares.
export function latestTwo(versions: SkillVersion[]): [SkillVersion, SkillVersion] | null {
  const [latest, previous] = [...versions].sort((a, b) => b.version - a.version);
  return previous ? [previous, latest] : null;
}

// Who last touched a skill, when and where, for the 版本 line and the diff heading.
export function changeSummary(skill: SkillInfo, now: number) {
  // 'app' is a built-in's shipped text, or a user skill as Agentrix first found it (no one changed it since).
  if (skill.updatedBy === 'app') return t(skill.source === 'builtin' ? '随应用更新' : '原有版本');
  if (skill.updatedBy === 'user') return t('你编辑于 {time}', { time: relativeTime(skill.updatedAt, now) });
  const what = skill.createdByAgent ? t('由 Agent 创建') : t('最近由 Agent 优化');
  return [what, relativeTime(skill.updatedAt, now), skill.updatedIn && t('项目 {name}', { name: skill.updatedIn })].filter(Boolean).join(' · ');
}

// The clock time of today's use, with the date in front of an earlier day's.
function clock(at: number) {
  const locale = currentLanguage() === 'en' ? 'en-US' : 'zh-CN', date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })} ${time}`;
}

// The proof a skill takes effect: the last time an agent Agentrix runs read it.
export function usedText(used: SkillInfo['lastUsed']) {
  return used ? t('最近一次生效：{time} · 项目 {project} · {agent}', { time: clock(used.at), project: used.project, agent: AGENT_NAMES[used.agent] }) : t('还没有 Agent 用过');
}

// What a built-in skill needs from the installed agents; a hollow dot marks an unavailable dependency or a disabled skill.
export function dependency(skill: SkillInfo): { text: string; state?: string; hollow: boolean } | null {
  const needs = skill.requires;
  if (!needs || needs.codex === null && needs.claude === null) return null;
  // A skill that names both agents works with either one (model routing has a plan for each alone).
  if (needs.codex !== null && needs.claude !== null) {
    const text = t('至少安装 Codex 或 Claude Code 其中一个');
    if (!skill.enabled) return { text, state: t('已关闭'), hollow: true };
    if (needs.codex && needs.claude) return { text, state: t('两个都已安装，按完整分工运行'), hollow: false };
    if (needs.codex || needs.claude) return { text, state: t('已安装 {agent}，按只装 {agent} 的方案分工', { agent: needs.codex ? 'Codex' : 'Claude Code' }), hollow: false };
    return { text, state: t('都未安装，技能暂不生效'), hollow: true };
  }
  if (!skill.enabled) return { text: t('已关闭'), hollow: true };
  const missing = [needs.codex === false && 'Codex', needs.claude === false && 'Claude Code'].filter(Boolean).join(' · ');
  if (missing) return { text: t('{agents} 未安装 · 将由主模型自己完成', { agents: missing }), hollow: true };
  return { text: t('{agents} 已安装', { agents: needs.codex ? 'Codex' : 'Claude Code' }), hollow: false };
}

export type ScopeOption = { value: string; label: string };

// 所有项目 and each open local project (SSH projects cannot hold skills); a skill scoped to a project that is no longer open keeps an entry of its own.
export function scopeOptions(projects: Project[], current?: { id: string | null; name: string | null }): ScopeOption[] {
  const options = [{ value: 'global', label: t('所有项目') }, ...projects.filter(project => project.kind === 'local').map(project => ({ value: project.id, label: project.name }))];
  return current?.id && !options.some(option => option.value === current.id) ? [...options, { value: current.id, label: current.name ?? current.id }] : options;
}
