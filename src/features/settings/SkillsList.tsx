import { FolderOpen, MagnifyingGlass, Plus } from '@phosphor-icons/react';
import type { SkillInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import { IconButton } from '../../shared/IconButton';
import { dependency } from './skill-text';

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
  const matches = (skill: SkillInfo) => !needle || `${skill.name} ${skill.description} ${skill.id}`.toLowerCase().includes(needle);
  const builtin = skills.filter(skill => skill.source === 'builtin'), mine = skills.filter(skill => skill.source === 'user');
  const row = (skill: SkillInfo) => <button type="button" key={skill.id} className="skills-item" data-skill-id={skill.id} aria-current={skill.id === selectedId ? 'true' : undefined} onClick={() => onSelect(skill.id)}>
    <span className="skills-item-name">{skill.name}</span><Mark skill={skill} />
  </button>;
  return <div className="skills-list">
    {skills.length >= SEARCH_FROM && <label className="search-input"><MagnifyingGlass size={16} /><input value={query} placeholder={t('搜索技能')} aria-label={t('搜索技能')} onChange={event => onQuery(event.target.value)} /></label>}
    <div className="skills-group" data-group="builtin">{t('系统自带')}<span>{builtin.length}</span></div>
    {builtin.filter(matches).map(row)}
    <div className="skills-group" data-group="mine">{t('我的技能')}<span className="skills-group-tools">{mine.length}
      <IconButton label={t('导入文件夹')} onClick={onImport}><FolderOpen size={16} /></IconButton>
      <IconButton label={t('新建技能')} onClick={onNew}><Plus size={16} /></IconButton></span></div>
    {mine.filter(matches).map(row)}
    {!mine.length && <p className="skills-list-note">{t('还没有自己的技能')}</p>}
    {mine.length > 0 && !mine.some(matches) && <p className="skills-list-note">{t('无匹配')}</p>}
  </div>;
}
