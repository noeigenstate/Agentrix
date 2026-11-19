import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RoleConfig, Seat, SeatMap, SeatModel, TeamRole } from '../../shared/types';
import { t } from '../../shared/i18n';
import { routingRoleName } from '../../shared/routing-command.ts';
import {
  checkTeamRules, nextRoleId, normalizeRoleText, ROLE_TEXT_LIMITS, validateCustomRole,
} from '../../../electron/features/skills/role-rules.mjs';
import { assignModel, rowFor } from './skill-seats';
import { routingError } from './RoutingReview';

export const roleName = (role: TeamRole) => role.source === 'custom' ? role.name : routingRoleName(role.name, t);
const labels = { name: '名称', duty: '职责', outputs: '产出' };

export function copyRole(id: string, draft: { from: TeamRole; roles: TeamRole[]; replace?: string }): RoleConfig {
  const base = draft.from.name.replace(/[,.()]/g, '');
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? '副本' : '副本' + number;
    const name = [...base].slice(0, ROLE_TEXT_LIMITS.name[1] - [...suffix].length).join('') + suffix;
    const roles = draft.roles.filter(role => role.id !== draft.replace);
    const duplicate = checkTeamRules([...roles, { ...draft.from, id, source: 'custom', name, enabled: true }]);
    if (duplicate?.code !== 'role-text') return { from: draft.from.id, name, duty: draft.from.detail, outputs: draft.from.outputs, enabled: true };
  }
}

function RoleTextFields({ value, locked, update }: { value: RoleConfig; locked: boolean; update: (value: RoleConfig) => void }) {
  return <>{(Object.keys(labels) as (keyof typeof labels)[]).map(field => {
    const text = value[field] ?? '', length = [...text.normalize('NFC').trim()].length, max = ROLE_TEXT_LIMITS[field][1];
    const invalid = !locked && normalizeRoleText(field, text) === null;
    const props = { value: text, readOnly: locked, onChange: (event: { target: { value: string } }) => update({ ...value, [field]: event.target.value }),
      'aria-invalid': invalid || undefined, name: field, 'data-role-text': field };
    return <label key={field}>{t(labels[field])} <small>{length}/{max}</small>
      {field === 'name' ? <input {...props} /> : <textarea {...props} rows={field === 'duty' ? 3 : 2} />}
      {invalid && <small>{t('检查文字长度与允许的字符。')}</small>}
    </label>;
  })}</>;
}

function RoleModel({ catalog, seat, inherited, update }: {
  catalog: SeatModel[]; seat?: Seat; inherited?: Seat; update: (seat: Seat | undefined) => void;
}) {
  const selected = seat && rowFor(catalog, seat.model);
  return <div className="seats-role-model">
    <label>{t('模型')}<select value={seat?.model ?? ''} onChange={event => {
      const model = event.target.value;
      if (!model) { update(undefined); return; }
      const prior = seat ?? inherited;
      const result = assignModel(prior ? { role: prior } : {}, 'role', model, catalog);
      if (result.ok) update({ ...result.map.role, fast: !!prior?.fast && !!result.map.role.fast });
    }}>
      <option value="">{t('继承模型')}{inherited && ` · ${inherited.model}`}</option>
      {seat && !catalog.some(row => row.model === seat.model) && <option value={seat.model}>{seat.model}</option>}
      {catalog.map(row => <option key={row.model} value={row.model} disabled={!row.available}>{row.label}</option>)}
    </select></label>
    {seat && selected && <>
      <label>{t('强度')}<select value={seat.effort} onChange={event => update({ ...seat, effort: event.target.value })}>
        {selected.efforts.map(effort => <option key={effort}>{effort}</option>)}
      </select></label>
      <label><input type="checkbox" checked={!!seat.fast} disabled={!selected.fast} onChange={event => update({ ...seat, fast: event.target.checked })} />{t('快速')}</label>
    </>}
  </div>;
}

type EditorProps = {
  id: string; initial: RoleConfig; existing?: TeamRole; replace?: string; roles: TeamRole[]; taken: string[];
  catalog: SeatModel[]; models: SeatMap; idLocked?: boolean; close: () => void; save: (id: string, value: RoleConfig) => void; copy: (role: TeamRole) => void;
};

function useEditor({ id, initial, existing, idLocked, replace, roles, taken, save, close }: EditorProps) {
  const [form, setForm] = useState({ id, value: initial, editedId: false });
  const fieldset = useRef<HTMLDivElement>(null);
  const { id: roleId, value } = form;
  const setValue = (value: RoleConfig) => setForm(previous => ({ ...previous, value }));
  const locked = !!existing && existing.source !== 'custom';
  const sources = roles.filter(role => role.source !== 'custom' && role.kind !== 'lead');
  const from = sources.find(role => role.id === value.from);
  const duplicate = roleId !== existing?.id && taken.includes(roleId) && roleId !== id;
  const textError = validateCustomRole(roleId, value, sources.map(role => role.id));
  const candidate = from && { ...from, id: roleId, name: normalizeRoleText('name', value.name) ?? '', source: 'custom' as const, enabled: value.enabled !== false };
  const others = roles.filter(role => role.id !== existing?.id).map(role => role.id === replace ? { ...role, enabled: false } : role);
  const error = duplicate ? { code: 'invalid-role' } : textError ?? (candidate ? checkTeamRules([...others, candidate]) : null);
  const changeFrom = (source: TeamRole) => setForm(previous => ({
    id: idLocked || previous.editedId ? previous.id : nextRoleId(source.id, taken),
    editedId: previous.editedId,
    value: { ...copyRole(roleId, { from: source, roles, replace }), enabled: previous.value.enabled },
  }));
  const submit = () => {
    if (error || locked) return;
    const field = (key: keyof typeof labels) => normalizeRoleText(key, value[key] ?? '') ?? '';
    save(roleId, { ...value, name: field('name'), duty: field('duty'), outputs: field('outputs') });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = fieldset.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey ? document.activeElement !== first : document.activeElement !== last) return;
    event.stopPropagation(); event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };
  useEffect(() => { fieldset.current?.querySelector<HTMLElement>('input, button')?.focus(); }, []);
  return { roleId, value, setValue, setForm, locked, sources, from, error, changeFrom, submit, keys, fieldset };
}

export function RoleEditor(props: EditorProps) {
  const { existing, idLocked, catalog, models, roles, close, copy, replace } = props;
  const form = useEditor(props);
  const { roleId, value, setValue, setForm, locked, sources, from, error, changeFrom, submit, keys, fieldset } = form;
  const lastReviewer = existing?.enabled && existing.kind === 'reviewer' &&
    roles.filter(role => role.enabled && role.kind === 'reviewer').length === 1;
  const seat = value.model && value.effort ? { model: value.model, effort: value.effort, fast: value.fast } : undefined;
  const updateSeat = (next: Seat | undefined) => {
    const { model, effort, fast, ...rest } = value;
    setValue({ ...rest, ...next });
  };
  return <div className="seats-role-scrim">
    <div className="seats-role-editor" ref={fieldset} role="dialog" aria-modal="true" aria-labelledby="role-editor-title" onKeyDown={keys}>
      <header><h3 id="role-editor-title">{t(existing ? '角色设置' : '新建角色')}</h3></header>
      <div className="seats-role-editor-body">
        <div className="seats-role-fields">
          {!locked && <>
            <label>{t('基于')}<select required value={value.from} onChange={event => {
              const source = sources.find(role => role.id === event.target.value);
              if (source) changeFrom(source);
            }}>{sources.map(role => <option key={role.id} value={role.id}>{roleName(role)}</option>)}</select></label>
            <label>{t('角色 ID')}<input value={roleId} readOnly={idLocked} onChange={event => setForm({ id: event.target.value, value, editedId: true })} /></label>
          </>}
          <RoleTextFields value={value} locked={locked} update={setValue} />
          {!locked && <RoleModel seat={seat} catalog={catalog} inherited={from && models[from.id]} update={updateSeat} />}
          {!locked && <div className="seats-role-model">
            <label title={lastReviewer ? t('至少保留一个审查角色。') : undefined}>
              <input type="checkbox" checked={value.enabled !== false} disabled={!!replace || lastReviewer}
              onChange={event => setValue({ ...value, enabled: event.target.checked })} />{t('启用')}</label>
            <label title={from?.kind === 'reviewer' ? t('审查角色始终使用新实例。') : undefined}>
              <input type="checkbox" disabled={from?.kind === 'reviewer'} checked={from?.kind === 'reviewer' || (value.fresh ?? !!from?.fresh)}
              onChange={event => setValue({ ...value, fresh: event.target.checked })} />{t('新实例')}</label>
          </div>}
          {!locked && error && <p role="status">{routingError(error)}</p>}
        </div>
        {!locked && <aside className="seats-role-preview">
          <p>{t('团队中的角色')}</p><h3>{value.name}</h3><p>{value.duty}</p>
          <p>{seat?.model ?? (from && models[from.id]?.model)} · {seat?.effort ?? (from && models[from.id]?.effort)}</p>
        </aside>}
      </div>
      <footer>
        <button type="button" className="seats-btn" onClick={close}>{t('取消')}</button>
        {locked ? !existing?.locked.includes('copy') && <button type="button" className="seats-btn is-primary"
          onClick={() => existing && copy(existing)}>{t('复制后自定义')}</button> :
          <button type="button" className="seats-btn is-primary" data-save-role disabled={!!error} onClick={submit}>
            {t(replace ? '复制并替换' : '保存角色')}
          </button>}
      </footer>
    </div>
  </div>;
}
