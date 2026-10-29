import type { SkillDraft } from '../../shared/types';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import type { ScopeOption } from './skill-text';

// A second click is due: delete asks twice, and saving over an agent's pending proposal asks what to do with it.
export type Confirm = 'delete' | 'save' | null;

// The form for a new skill (id null) or an existing user skill: name, description, scope and the SKILL.md text.
export function SkillEditForm({ id, name, draft, scopes, confirm, onChange, onSave, onCancel, onDelete, onDismiss }: {
  id: string | null; name: string; draft: SkillDraft; scopes: ScopeOption[]; confirm: Confirm;
  onChange: (draft: SkillDraft) => void; onSave: () => void; onCancel: () => void; onDelete: () => void; onDismiss: () => void;
}) {
  const field = (key: 'name' | 'description') => (event: { target: { value: string } }) => onChange({ ...draft, [key]: event.target.value });
  const scope = draft.scope === 'project' && draft.projectId ? draft.projectId : 'global';
  return <div className="skills-detail">
    <div className="skills-title"><b>{id ? t('编辑 {name}', { name }) : t('新建技能')}</b></div>
    <dl className="skills-facts">
      <div><dt>{t('名称')}</dt><dd><input className="skills-input" data-field="name" value={draft.name} placeholder={t('例如 发布流程')} aria-label={t('名称')} onChange={field('name')} /></dd></div>
      <div><dt>{t('描述')}</dt><dd><input className="skills-input" data-field="description" value={draft.description} placeholder={t('一句话：什么时候该用它')} aria-label={t('描述')} onChange={field('description')} /></dd></div>
      <div><dt>{t('范围')}</dt><dd><Select label={t('范围')} className="skills-scope" value={scope} options={scopes}
        onChange={value => onChange({ ...draft, scope: value === 'global' ? 'global' : 'project', projectId: value === 'global' ? null : value })} /></dd></div>
    </dl>
    <h4 className="skills-heading">SKILL.md</h4>
    <textarea className="skills-textarea" data-field="text" value={draft.text} aria-label="SKILL.md" spellCheck={false} onChange={event => onChange({ ...draft, text: event.target.value })} />
    {confirm === 'save' ? <div className="skills-foot">
      <span className="skills-foot-note" role="alert">{t('Agent 提议的修改尚未处理，保存会丢弃它。继续？')}</span>
      <button type="button" className="button" onClick={onDismiss}>{t('取消')}</button>
      <button type="button" className="button primary" onClick={onSave}>{t('继续')}</button>
    </div> : <div className="skills-foot">
      {id && <button type="button" className="text-button" data-skill-delete onClick={onDelete}>{confirm === 'delete' ? t('再点一次确认删除') : t('删除')}</button>}
      <button type="button" className="button" onClick={onCancel}>{t('取消')}</button>
      <button type="button" className="button primary" disabled={!draft.name.trim()} onClick={onSave}>{id ? t('保存') : t('创建')}</button>
    </div>}
  </div>;
}
