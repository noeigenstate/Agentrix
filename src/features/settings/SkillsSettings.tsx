import { FolderOpen, Plus } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import type { Project, Result, SkillDetail, SkillDraft, SkillInfo, SkillOptions } from '../../shared/types';
import { t } from '../../shared/i18n';
import { SkillDetailPane, type SkillTab } from './SkillDetailPane';
import { type Confirm, SkillEditForm } from './SkillEditForm';
import { SkillsList } from './SkillsList';
import { folderName, scopeOptions } from './skill-text';
import './skills-settings.css';

const api = window.agentrix;
type Editing = { id: string | null; draft: SkillDraft };

function EmptyMine({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  return <div className="skills-detail skills-empty">
    <b>{t('还没有自己的技能')}</b>
    <span>{t('新建一个，或导入一个含 SKILL.md 的文件夹。Agent 在项目里发现可复用的流程时，也会在这里留下新技能，等你看一眼。')}</span>
    <div className="skills-empty-actions">
      <button type="button" className="button" onClick={onImport}><FolderOpen size={16} />{t('导入文件夹')}</button>
      <button type="button" className="button primary" onClick={onNew}><Plus size={16} />{t('新建技能')}</button>
    </div>
  </div>;
}

// Settings › 技能: the built-in and the user's own skills on the left, one skill's controls and text on the right.
export function SkillsSettings({ projects }: { projects: Project[] }) {
  // null until the first list arrives, so the empty state does not flash before it.
  const [loaded, setSkills] = useState<SkillInfo[] | null>(null), skills = loaded ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<(SkillDetail & { id: string }) | null>(null);
  const [tab, setTab] = useState<SkillTab>('text');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  // Every call reports a failed result or a thrown error in one line and yields the value on success.
  const call = async <T,>(request: Promise<Result<T>>): Promise<T | undefined> => {
    setError('');
    try {
      const result = await request;
      if (result.ok) return result.value;
      setError(result.error);
    } catch (err) { setError(String(err)); }
    return undefined;
  };
  const refresh = async () => { const list = await call(api.listSkills()); if (list) setSkills(list); };
  useEffect(() => { void refresh(); return api.onSkills(setSkills); }, []);

  const mine = skills.filter(skill => skill.source === 'user');
  // Nothing picked: the first built-in, unless the user has no skills yet, which shows how to make one.
  const selected = skills.find(skill => skill.id === selectedId) ?? (mine.length ? skills.find(skill => skill.source === 'builtin') ?? mine[0] : undefined);
  const shown = detail?.id === selected?.id ? detail : null;
  useEffect(() => { setTab('text'); setConfirm(null); }, [selected?.id]);
  // The text and versions are read again whenever the skill changes underneath, such as an agent's edit.
  useEffect(() => {
    let current = true;
    if (!selected) { setDetail(null); return; }
    void call(api.readSkill(selected.id)).then(value => { if (current && value) setDetail({ ...value, id: selected.id }); });
    return () => { current = false; };
  }, [selected?.id, selected?.version, selected?.pending]);

  const change = async <T,>(request: Promise<Result<T>>) => { const value = await call(request); if (value !== undefined) await refresh(); return value; };
  const choose = (id: string) => { setEditing(null); setSelectedId(id); };
  const editedSkill = editing?.id ? skills.find(skill => skill.id === editing.id) : undefined;
  const draftOf = (skill: SkillInfo, text: string): SkillDraft => ({ name: skill.name, description: skill.description, scope: skill.scope === 'project' ? 'project' : 'global', projectId: skill.projectId, text });
  const create = () => { setSelectedId(null); setConfirm(null); setEditing({ id: null, draft: { name: '', description: '', scope: 'global', projectId: null, text: '' } }); };
  const importFolder = async () => { const imported = await change(api.importSkill('global', null)); if (imported) choose(imported.id); };
  // The name field shows the SKILL.md name, but saving sends the folder's name unless it was edited: the name renames the folder and so changes the id.
  const send = (skill: SkillInfo | undefined, draft: SkillDraft) => api.saveSkill(skill?.id ?? null, skill && draft.name === skill.name ? { ...draft, name: folderName(skill) } : draft);
  const save = async () => {
    if (!editing) return;
    // Saving replaces the text an agent proposed, so ask before that proposal is lost.
    if (editedSkill?.pending && confirm !== 'save') { setConfirm('save'); return; }
    setConfirm(null);
    const saved = await change(send(editedSkill, editing.draft));
    if (saved) { setEditing(null); setSelectedId(saved.id); }
  };
  const remove = async () => {
    if (!editing?.id) return;
    if (confirm !== 'delete') { setConfirm('delete'); return; }
    if (await change(api.deleteSkill(editing.id))) { setEditing(null); setSelectedId(null); setConfirm(null); }
  };
  const setScope = async (value: string) => {
    if (!selected || !shown) return;
    const saved = await change(send(selected, { ...draftOf(selected, shown.text), scope: value === 'global' ? 'global' : 'project', projectId: value === 'global' ? null : value }));
    if (saved) setSelectedId(saved.id);
  };
  const actions = selected && {
    onOptions: (options: SkillOptions) => void change(api.setSkillOptions(selected.id, options)),
    onScope: (value: string) => void setScope(value),
    onEdit: () => shown && setEditing({ id: selected.id, draft: draftOf(selected, shown.text) }),
    onRevert: (version: number) => void change(api.revertSkill(selected.id, version)),
    onResolve: (accept: boolean) => void change(api.resolveSkillChange(selected.id, accept)),
    onTab: setTab,
  };
  const scopeOf = editing ? { id: editing.draft.projectId, name: editedSkill?.projectName ?? null } : { id: selected?.projectId ?? null, name: selected?.projectName ?? null };

  return <div className="skills-settings">
    <SkillsList skills={skills} selectedId={editing ? editing.id : selected?.id ?? null} query={query} onQuery={setQuery} onSelect={choose} onNew={create} onImport={() => void importFolder()} />
    <div className="skills-pane">
      {error && <p className="form-error skills-error" role="alert">{error}</p>}
      {editing ? <SkillEditForm id={editing.id} name={editedSkill?.name ?? ''} draft={editing.draft} scopes={scopeOptions(projects, scopeOf)} confirm={confirm}
        onChange={draft => setEditing({ ...editing, draft })} onSave={() => void save()} onCancel={() => { setEditing(null); setConfirm(null); }} onDelete={() => void remove()} onDismiss={() => setConfirm(null)} />
        : selected && actions ? <SkillDetailPane skill={selected} detail={shown} scopes={scopeOptions(projects, scopeOf)} tab={tab} now={Date.now()} actions={actions} />
        : loaded && <EmptyMine onNew={create} onImport={() => void importFolder()} />}
    </div>
  </div>;
}
