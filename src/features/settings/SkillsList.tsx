import { FolderOpen, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { SkillInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { dependency, replacedCount, skillRows, skillSummary, skillTitle } from './skill-text';

// Below this many skills a list needs no search.
const SEARCH_FROM = 8;

// The mark at a row's end: 新 for a skill an agent made, 待确认 for a proposed change, a hollow dot for one that is off or falls back.
function Mark({ skill }: { skill: SkillInfo }) {
  if (skill.createdByAgent) return <span className="skills-mark">{t('新')}</span>;
  if (skill.pending) return <span className="skills-mark">{t('待确认')}</span>;
  return !skill.enabled || dependency(skill)?.hollow ? <i className="skills-dot is-hollow" aria-hidden="true" /> : null;
}

export function SkillsList({ skills, selectedId, query, onQuery, onSelect, onNew, onImport }: {
  skills: SkillInfo[]; selectedId: string | null; query: string;
  onQuery: (query: string) => void; onSelect: (id: string) => void; onNew: () => void; onImport: () => void;
}) {
  const needle = query.trim().toLowerCase();
  const matches = (skill: SkillInfo) => !needle || `${skillTitle(skill)} ${skillSummary(skill)} ${skill.name} ${skill.id}`.toLowerCase().includes(needle);
  const rows = skillRows(skills, matches), builtinTotal = skills.filter(skill => skill.source === 'builtin').length;
  const row = (skill: SkillInfo) => {
    const title = skillTitle(skill), extension = skill.extends !== null, replaced = replacedCount(skill);
    // The row is only 240px wide: the tag stays short (the detail title has the base's name) and the title holds the full name.
    return <button type="button" key={skill.id} title={title} className={extension ? 'skills-item is-extension' : 'skills-item'} data-skill-id={skill.id} data-skill-extends={skill.extends ?? undefined} data-skill-replaced={replaced || undefined}
      aria-current={skill.id === selectedId ? 'true' : undefined} onClick={() => onSelect(skill.id)}>
      <span className="skills-item-name">{title}</span>
      {extension && <span className="skills-tag">{t('扩展')}</span>}
      {replaced > 0 && <span className="skills-count">{t('已替换 {n}', { n: replaced })}</span>}
      <Mark skill={skill} />
    </button>;
  };
  return <div className="skills-list">
    {skills.length >= SEARCH_FROM && <label className="search-input"><MagnifyingGlass size={16} /><input value={query} placeholder={t('搜索技能')} aria-label={t('搜索技能')} onChange={event => onQuery(event.target.value)} /></label>}
    <div className="skills-group" data-group="builtin">{t('系统自带')}<span>{builtinTotal}</span></div>
    {rows.builtin.map(row)}
    <div className="skills-group" data-group="mine">{t('我的技能')}<span className="skills-group-tools">{rows.mineTotal}
      <IconButton label={t('导入文件夹')} onClick={onImport}><FolderOpen size={16} /></IconButton>
      <IconButton label={t('新建技能')} onClick={onNew}><Plus size={16} /></IconButton></span></div>
    {rows.mine.map(row)}
    {!rows.mineTotal && <p className="skills-list-note">{t('还没有自己的技能')}</p>}
    {rows.mineTotal > 0 && !rows.mine.length && <p className="skills-list-note">{t('无匹配')}</p>}
  </div>;
}
