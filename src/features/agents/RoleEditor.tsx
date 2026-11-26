import { Warning, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RoleConfig, Seat, SeatMap, SeatModel, TeamRole } from '../../shared/types';
import { t } from '../../shared/i18n';
import { routingRoleName } from '../../shared/routing-command.ts';
import {
  checkTeamRules, nextRoleId, normalizeRoleText, ROLE_TEXT_LIMITS, validateCustomRole,
} from '../../../electron/features/routing/role-rules.mjs';
import { assignModel, rowFor } from './routing-seats';
import { escapeRoutingText, routingError } from './RoutingReview';

export const roleName = (role: TeamRole) => role.source === 'custom' ? role.name : routingRoleName(role.name, t);
export function sameRoleConfig(a?: RoleConfig, b?: RoleConfig) {
  return a === b || !!a && !!b && Object.keys(a).length === Object.keys(b).length &&
    (Object.keys(a) as (keyof RoleConfig)[]).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}
const labels = { name: '名称', duty: '职责', outputs: '产出' };
type RoleField = keyof typeof labels;
const textFields = Object.keys(labels) as RoleField[];
type FieldErrors = Partial<Record<RoleField, string>>;

export function copyRole(id: string, draft: { from: TeamRole; roles: TeamRole[]; replace?: string }): RoleConfig {
  const base = draft.from.name.replace(/[,.()]/g, '');
  const copy = t('副本');
  for (let number = 1; ; number++) {
    const suffix = number === 1 ? copy : copy + number;
    const name = [...base].slice(0, ROLE_TEXT_LIMITS.name[1] - [...suffix].length).join('').trimEnd() + suffix;
    const roles = draft.roles.filter(role => role.id !== draft.replace);
    const duplicate = checkTeamRules([...roles, { ...draft.from, id, source: 'custom', name, enabled: true }]);
    if (duplicate?.code !== 'role-text') return { from: draft.from.id, name, duty: draft.from.detail, outputs: draft.from.outputs, enabled: true };
  }
}

function textIssue(field: RoleField, text: string) {
  const length = [...text.normalize('NFC').trim()].length;
  const [min, max] = ROLE_TEXT_LIMITS[field];
  if (length < min) return t(field === 'name' ? '请输入名称。' : '请输入职责。');
  if (length > max) return t('{field}最多可填 {max} 个字符，当前为 {count} 个。', { field: t(labels[field]), max, count: length });
  if (normalizeRoleText(field, text) !== null) return;
  const refused = [...text].find(char => normalizeRoleText(field, 'A' + char + 'A') === null);
  return refused ? t('不允许字符 {character}。', { character: escapeRoutingText(refused) }) : t('请检查连续空格或组合字符。');
}

function conflictingRole(candidate: TeamRole, others: TeamRole[]) {
  // Isolate name checks from team size and membership checks while keeping the shared name comparison.
  const probe: TeamRole[] = [
    { ...candidate, id: 'orchestrator', kind: 'lead', name: '\0lead', enabled: true },
    { ...candidate, id: 'reviewer', kind: 'reviewer', name: '\0reviewer', enabled: true },
    { ...candidate, enabled: true },
  ];
  return others.find(role => {
    if (role.source === 'custom' && !(role.enabled && candidate.enabled)) return false;
    const names = role.source === 'custom' ? [role.name] : [role.name, roleName(role)];
    return checkTeamRules(probe, names)?.code === 'role-text';
  });
}

function RoleTextFields({ value, locked, errors, update }: { value: RoleConfig; locked: boolean; errors: FieldErrors; update: (value: RoleConfig) => void }) {
  return <>{textFields.map(field => {
    const text = value[field] ?? '', length = [...text.normalize('NFC').trim()].length, max = ROLE_TEXT_LIMITS[field][1];
    const error = errors[field], errorId = 'role-error-' + field;
    const props = { value: text, readOnly: locked, onChange: (event: { target: { value: string } }) => update({ ...value, [field]: event.target.value }),
      'aria-invalid': !!error || undefined, 'aria-describedby': error ? errorId : undefined, name: field, 'data-role-text': field };
    return <label key={field}>{t(labels[field])} <span className="seats-role-counter">{length}/{max}</span>
      {field === 'name' ? <input {...props} /> : <textarea {...props} rows={field === 'duty' ? 3 : 2} />}
      {error && <span id={errorId} className="seats-role-error" data-role-error={field}>{error}</span>}
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
      <label className="seats-check">
        <input type="checkbox" checked={!!seat.fast} disabled={!selected.fast} onChange={event => update({ ...seat, fast: event.target.checked })} />{t('快速')}
      </label>
    </>}
  </div>;
}

type EditorProps = {
  id: string; initial: RoleConfig; existing?: TeamRole; replace?: string; roles: TeamRole[]; taken: string[];
  catalog: SeatModel[]; models: SeatMap; idLocked?: boolean; close: () => void; save: (id: string, value: RoleConfig) => void; copy: (role: TeamRole) => void;
};

function useEditor({ id, initial, existing, idLocked, replace, roles, taken, save }: EditorProps) {
  const [form, setForm] = useState({ id, value: initial, editedId: false });
  const { id: roleId, value } = form;
  const setValue = (value: RoleConfig) => setForm(previous => ({ ...previous, value }));
  const locked = !!existing && existing.source !== 'custom';
  const sources = roles.filter(role => role.source !== 'custom' && role.kind !== 'lead');
  const from = sources.find(role => role.id === value.from);
  const duplicate = roleId !== existing?.id && taken.includes(roleId) && roleId !== id;
  const textError = validateCustomRole(roleId, value, sources.map(role => role.id));
  const candidate = from && { ...from, id: roleId, name: normalizeRoleText('name', value.name) ?? '', source: 'custom' as const, enabled: value.enabled !== false };
  const others = roles.filter(role => role.id !== existing?.id).map(role => role.id === replace ? { ...role, enabled: false } : role);
  const fieldErrors: FieldErrors = {};
  if (!locked) for (const field of textFields) fieldErrors[field] = textIssue(field, value[field] ?? '');
  const collision = !locked && candidate && !fieldErrors.name && conflictingRole(candidate, others);
  if (collision) fieldErrors.name = t('名称与角色「{role}」重复。', { role: roleName(collision) });
  const fieldsInvalid = Object.values(fieldErrors).some(Boolean);
  const error = duplicate ? { code: 'invalid-role' } : fieldsInvalid ? null : textError ?? (candidate ? checkTeamRules([...others, candidate]) : null);
  const changeFrom = (source: TeamRole) => setForm(previous => ({
    id: idLocked || previous.editedId ? previous.id : nextRoleId(source.id, taken),
    editedId: previous.editedId,
    value: { ...copyRole(roleId, { from: source, roles, replace }), enabled: previous.value.enabled },
  }));
  const submit = () => {
    if (error || fieldsInvalid || locked) return;
    const field = (key: keyof typeof labels) => normalizeRoleText(key, value[key] ?? '') ?? '';
    save(roleId, { ...value, name: field('name'), duty: field('duty'), outputs: field('outputs') });
  };
  return { roleId, value, setValue, setForm, locked, sources, from, error, fieldErrors, fieldsInvalid, changeFrom, submit };
}

function useEditorClose(dirty: boolean, close: () => void) {
  const [discard, setDiscard] = useState(false);
  const fieldset = useRef<HTMLDivElement>(null), prompt = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const requestClose = () => {
    if (!dirty) { close(); return; }
    if (discard) return;
    previous.current = document.activeElement as HTMLElement | null;
    setDiscard(true);
  };
  const keep = () => setDiscard(false);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (discard) keep(); else requestClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = (discard ? prompt : fieldset).current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey ? document.activeElement !== first : document.activeElement !== last) return;
    event.stopPropagation(); event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };
  useEffect(() => {
    if (discard) { prompt.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); return; }
    const target = previous.current?.isConnected ? previous.current : fieldset.current?.querySelector<HTMLElement>('input, button');
    target?.focus({ preventScroll: true });
    previous.current = null;
  }, [discard]);
  return { requestClose, discard, keep, keys, fieldset, prompt };
}

export function RoleEditor(props: EditorProps) {
  const { existing, idLocked, catalog, models, close, copy, replace } = props;
  const form = useEditor(props);
  const { roleId, value, setValue, setForm, locked, sources, from, error, changeFrom, submit } = form;
  const { requestClose, discard, keep, keys, fieldset, prompt } = useEditorClose(roleId !== props.id || !sameRoleConfig(value, props.initial), close);
  const seat = value.model && value.effort ? { model: value.model, effort: value.effort, fast: value.fast } : undefined;
  const updateSeat = (next: Seat | undefined) => {
    const { model, effort, fast, ...rest } = value;
    setValue({ ...rest, ...next });
  };
  return <div className="seats-role-scrim" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); requestClose(); } }}>
    <div className="seats-role-editor" ref={fieldset} role="dialog" aria-modal="true" aria-labelledby="role-editor-title" onKeyDown={keys}>
      <header inert={discard}>
        <h3 id="role-editor-title">{existing ? t('角色设置 · {role}', { role: roleName(existing) }) : t('新建角色')}</h3>
        <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={requestClose}><X size={16} aria-hidden="true" /></button>
      </header>
      <div className="seats-role-editor-body" inert={discard}>
        <div className="seats-role-fields">
          {!locked && <>
            <label>{t('基于')}<select required value={value.from} onChange={event => {
              const source = sources.find(role => role.id === event.target.value);
              if (source) changeFrom(source);
            }}>{sources.map(role => <option key={role.id} value={role.id}>{roleName(role)}</option>)}</select></label>
            <label>{t('角色 ID')}<input value={roleId} readOnly={idLocked} onChange={event => setForm({ id: event.target.value, value, editedId: true })} /></label>
          </>}
          <RoleTextFields value={value} locked={locked} errors={form.fieldErrors} update={setValue} />
          {!locked && <RoleModel seat={seat} catalog={catalog} inherited={from && models[from.id]} update={updateSeat} />}
          {!locked && <div className="seats-role-model">
            <div className="seats-role-toggle">
              <label className="seats-check"><input type="checkbox" checked={value.enabled !== false} disabled={!!replace}
                onChange={event => setValue({ ...value, enabled: event.target.checked })} />{t('启用')}</label>
            </div>
            <div className="seats-role-toggle">
              <label className="seats-check">
                <input type="checkbox" checked={value.fresh ?? !!from?.fresh}
                  onChange={event => setValue({ ...value, fresh: event.target.checked })} />{t('新实例')}
              </label>
            </div>
          </div>}
          {!locked && error && <p role="status">{routingError(error)}</p>}
        </div>
        {!locked && <aside className="seats-role-preview">
          <p>{t('团队中的角色')}</p><h3>{value.name}</h3><p>{value.duty}</p>
          <p>{seat?.model ?? (from && models[from.id]?.model)} · {seat?.effort ?? (from && models[from.id]?.effort)}</p>
        </aside>}
      </div>
      <footer>
        {discard ? <div ref={prompt} className="seats-banner is-warn seats-editor-discard" role="alertdialog" aria-label={t('放弃未保存的修改？')}>
          <Warning size={14} aria-hidden="true" /><span>{t('关闭会丢掉未保存的修改。')}</span>
          <button type="button" className="seats-btn" onClick={keep}>{t('继续编辑')}</button>
          <button type="button" className="seats-btn" onClick={close}>{t('放弃修改')}</button>
        </div> : <div className="seats-editor-actions">
          <button type="button" className="seats-btn" onClick={requestClose}>{t('取消')}</button>
          {locked ? !existing?.locked.includes('copy') && <button type="button" className="seats-btn is-primary"
            onClick={() => existing && copy(existing)}>{t('复制后自定义')}</button> :
            <button type="button" className="seats-btn is-primary" data-save-role disabled={!!error || form.fieldsInvalid} onClick={submit}>
              {t(replace ? '复制并替换' : '保存角色')}
            </button>}
        </div>}
      </footer>
    </div>
  </div>;
}
