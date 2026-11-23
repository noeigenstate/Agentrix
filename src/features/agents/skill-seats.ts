import type { CallRow } from './subagent-splits.ts';
import type {
  RoleConfig, RoutingConfig, Seat, SeatId, SeatIssue, SeatMap, SeatModel,
  SeatRole, SeatsInfo, SeatsSaveError, TeamRole,
} from '../../shared/types';
import { aliasTarget } from '../../shared/routing-command.ts';
import { BASE_EFFORTS, allowsUltracode, familyOf, rankByName, unsupportedEffort, validModel } from '../../../electron/features/skills/seat-rules.mjs';

import { roleLocks } from '../../../electron/features/skills/role-rules.mjs';

export { allowsUltracode, familyOf };

export function displayedSeat(info: SeatsInfo, id: SeatId) {
  return id === info.lead ? info.current?.[id] ?? info.effective[id] : info.effective[id];
}

export const seatSettingText = (seat: Seat, model: string, fast: string) =>
  [model, seat.effort, seat.fast && fast, seat.ultracode && 'Ultracode'].filter(Boolean).join(' · ');

// The dialog checks seat edits before saving. Main still validates saves and the dialog shows its refusal.
export type SlotId = SeatId;
export type Scope = 'template' | 'project';
type Family = 'claude' | 'codex';
type EditRefusal = 'unknown-model' | 'unavailable' | 'same' | 'effort' | 'fast' | 'invalid-id';
export type Edit = { ok: true; map: SeatMap } | { ok: false; reason: EditRefusal };


// A shorter name for a small tile: "Opus (follows latest)" is "Opus (latest)"; the menu and the list keep the full text.
export const shortLabel = (label: string) => label.replace(/\s*\(follows latest\)$/i, ' (latest)');
// Where the 更换 menu goes: under its button, else above it, else on the roomier side; it never leaves the viewport, and the model list scrolls inside it (maxHeight).
export function menuPlacement(anchor: { left: number; top: number; bottom: number }, view: { width: number; height: number }, rows: number) {
  const margin = 16, gap = 4;
  const width = Math.min(320, Math.max(0, view.width - margin * 2));
  const limit = Math.max(0, view.height - margin * 2);
  const left = Math.max(margin, Math.min(view.width - margin - width, Math.round(anchor.left)));
  const top = Math.max(margin, Math.ceil(anchor.bottom + gap)), bottom = Math.max(margin, Math.ceil(view.height - anchor.top + gap));
  const below = Math.max(0, view.height - margin - top), above = Math.max(0, view.height - margin - bottom);
  const need = Math.min(rows * 40 + 80, 480, limit);
  if (below >= need || below >= above) return { left, width, top, maxHeight: Math.min(below, 480) };
  return { left, width, bottom, maxHeight: Math.min(above, 480) };
}
export const getSlot = (map: SeatMap, slot: SlotId): Seat | undefined => map[slot];
export const withSlot = (map: SeatMap, slot: SlotId, seat: Seat): SeatMap => ({ ...map, [slot]: seat });
export const sameSeat = (a?: Seat, b?: Seat) => !!a && !!b && a.model === b.model && a.effort === b.effort
  && !!a.fast === !!b.fast && !!a.ultracode === !!b.ultracode;
export const modelRow = (catalog: SeatModel[], model: string) => catalog.find(row => row.model === model);
// A model the catalog does not know is not judged unavailable.
export const isAvailable = (catalog: SeatModel[], model: string) => modelRow(catalog, model)?.available !== false;
// An agent that is not installed cannot run its models: its rows are greyed with the reason, whatever the list says.
export const withInstalled = (catalog: SeatModel[], installed: SeatsInfo['installed'] | undefined, reasonOf: (family: Family) => string): SeatModel[] =>
  catalog.map(row => installed && installed[row.family] === false && row.available ? { ...row, available: false, reason: reasonOf(row.family) } : row);
// An alias (opus) and the newest listed id of its tier (claude-opus-5-5) are one model; a [1m] or date suffix does not make another.
const TIER = /^claude-(opus|sonnet|haiku)-(\d+(?:-\d{1,2})*)(?:-\d{8})?$/;
const bare = (model: string) => model.replace(/\[[^\]]*\]$/, '');
const versionOf = (model: string) => (TIER.exec(bare(model))?.[2] ?? '').split('-').map(Number);
const newer = (a: number[], b: number[]) => { for (let at = 0; at < Math.max(a.length, b.length); at++) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) > (b[at] ?? 0); return false; };
export function canonicalModel(catalog: SeatModel[], model: string): string {
  const id = bare(model);
  if (!/^(opus|sonnet|haiku)$/.test(id)) return id.replace(/-\d{8}$/, '');
  let best: string | null = null;
  for (const row of catalog) if (row.listed !== false && TIER.exec(bare(row.model))?.[1] === id && (!best || newer(versionOf(row.model), versionOf(best)))) best = row.model;
  return best ? bare(best).replace(/-\d{8}$/, '') : id;
}
export const sameModel = (catalog: SeatModel[], a: string, b: string) => a === b || canonicalModel(catalog, a) === canonicalModel(catalog, b);
// A typed-in id the catalog does not list: its family comes from the id, its efforts from the family's base list, fast only where Codex can apply it.
const customRow = (model: string): SeatModel => {
  const family = familyOf(model);
  return { model, label: model, family, efforts: BASE_EFFORTS[family], fast: family === 'codex',
    ...(family === 'codex' ? {} : { fastReason: 'unknown' as const }), rank: rankByName(model), available: true, source: 'custom' };
};
// The catalog's row, or the row a valid typed-in id would get.
export const rowFor = (catalog: SeatModel[], model: string) => modelRow(catalog, model) ?? (validModel(model) ? customRow(model) : undefined);
// The issues main reported for a slot.
export const issuesOf = (info: SeatsInfo, slot: SlotId): SeatIssue[] => (info.issues ?? []).filter(issue => issue.slot === slot);
// How long ago a model list was read, as a unit and a count for the dialog to word.
export function ageOf(at: number | null, now: number): { unit: 'never' | 'now' | 'min' | 'hour' | 'day'; count: number } {
  if (!at) return { unit: 'never', count: 0 };
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? { unit: 'now', count: 0 } : minutes < 60 ? { unit: 'min', count: minutes } : minutes < 2880 ? { unit: 'hour', count: Math.floor(minutes / 60) } : { unit: 'day', count: Math.floor(minutes / 1440) };
}

export const configFor = (info: SeatsInfo, scope: Scope): RoutingConfig =>
  scope === 'template' ? info.template : info.config ?? info.template;
export const startScope = (_info: SeatsInfo, projectId?: string): Scope => projectId ? 'project' : 'template';

export function draftRoles(info: SeatsInfo, config: RoutingConfig): TeamRole[] {
  const shipped = info.roles.filter(role => role.source !== 'custom');
  const overrides = Object.keys(config.roles).sort().map(id => [id, config.roles[id]] as const);
  return shipped.flatMap(role => {
    const values = config.roles[role.id];
    const defaultEnabled = role.defaultEnabled === true, defaultFresh = role.defaultFresh === true;
    const base = { ...role, defaultEnabled, defaultFresh, enabled: role.locked.includes('enabled') ? defaultEnabled : values?.enabled ?? defaultEnabled,
      fresh: role.locked.includes('fresh') ? defaultFresh : values?.fresh ?? defaultFresh };
    const copies = overrides.filter(([, value]) => value.from === role.id).map(([id, value]): TeamRole => ({
      ...base, id, source: 'custom', from: role.id, name: value.name ?? '', duty: value.duty ?? '', detail: '',
      outputs: value.outputs ?? '', defaultEnabled: true, defaultFresh: base.fresh, inherits: role.id, defaultSeat: undefined,
      enabled: value.enabled ?? true, fresh: role.locked.includes('fresh') ? base.fresh : value.fresh ?? base.fresh,
      locked: roleLocks(role.kind, 'custom'),
    }));
    return [base, ...copies];
  });
}

function seatOf(value: RoleConfig | undefined, isLead: boolean): Seat | undefined {
  if (!value?.model || !value.effort) return;
  return { model: value.model, effort: value.effort, ...(value.fast && { fast: true }),
    ...(value.ultracode === true && allowsUltracode(value.model, isLead) && { ultracode: true }) };
}

function seedSeat(role: TeamRole | undefined, defaults: SeatMap, resolve: (id: SeatId) => Seat | undefined) {
  if (!role) return;
  const parent = role.inherits ?? role.from;
  return parent ? resolve(parent) : role.defaultSeat ?? defaults[role.id];
}

export function resolveDraftSeats(defaults: SeatMap, roles: TeamRole[], config: RoutingConfig): SeatMap {
  const byId = new Map(roles.map(role => [role.id, role]));
  const map: SeatMap = {};
  const resolve = (id: string): Seat | undefined => {
    if (Object.hasOwn(map, id)) return map[id];
    const role = byId.get(id);
    const seat = seatOf(config.roles[id], role?.kind === 'lead') ?? seedSeat(role, defaults, resolve);
    if (seat) map[id] = seat;
    return seat;
  };
  roles.forEach(role => resolve(role.id));
  return map;
}

export const baselineFor = (info: SeatsInfo, scope: Scope) => resolveDraftSeats(info.defaults, draftRoles(info, configFor(info, scope)), configFor(info, scope));

export function updateDraftSeats(config: RoutingConfig, previous: SeatMap, next: SeatMap): RoutingConfig {
  const roles = { ...config.roles };
  for (const [id, seat] of Object.entries(next)) {
    if (!sameSeat(previous[id], seat)) roles[id] = { ...roles[id], ...seat, fast: !!seat.fast, ultracode: !!seat.ultracode };
  }
  return { ...config, roles };
}

export function cleanDraft(info: SeatsInfo, config: RoutingConfig): RoutingConfig {
  const roles = draftRoles(info, config), resolved = resolveDraftSeats(info.defaults, roles, config);
  const entries = roles.flatMap(role => {
    const entry = config.roles[role.id];
    if (!entry) return [];
    const { model, effort, fast, ultracode, ...rest } = entry;
    const inherited = seedSeat(role, info.defaults, id => resolved[id]);
    if (rest.enabled === role.defaultEnabled || role.locked.includes('enabled')) delete rest.enabled;
    if (rest.fresh === role.defaultFresh || role.locked.includes('fresh')) delete rest.fresh;
    const seat = seatOf(entry, role.kind === 'lead');
    const value = { ...rest, ...(seat && !sameSeat(seat, inherited) ? seat : {}) };
    return Object.keys(value).length ? [[role.id, value] as const] : [];
  });
  return { roles: Object.fromEntries(entries), ...(config.conductor && { conductor: true }) };
}

// A seat's model moved into another seat keeps its effort and fast only where the new model allows them (Claude fast stays off unless the seat already had it).
function fitSeat(seat: Seat, row: SeatModel, ultracode = seat.ultracode): Seat {
  const effort = fitEffort(row, seat.effort);
  const fast = row.family === 'codex' ? seat.fast ?? true : familyOf(seat.model) === 'claude' && !!seat.fast;
  return { model: row.model, effort, ...(row.fast && { fast }), ...(allowsUltracode(row.model, !!ultracode) && { ultracode: true }) };
}

function fitEffort(row: SeatModel, effort?: string) {
  if (effort && row.efforts.includes(effort)) return effort;
  if (row.defaultEffort && row.efforts.includes(row.defaultEffort)) return row.defaultEffort;
  return row.efforts.includes('high') ? 'high' : row.efforts[row.efforts.length - 1];
}

function assignRow(map: SeatMap, slot: SlotId, row: SeatModel | undefined): Edit {
  const current = getSlot(map, slot);
  if (!row) return { ok: false, reason: 'unknown-model' };
  if (!row.available) return { ok: false, reason: 'unavailable' };
  if (current?.model === row.model) return { ok: false, reason: 'same' };
  return { ok: true, map: withSlot(map, slot, fitSeat(current ?? { model: row.model, effort: 'high' }, row)) };
}
export const assignModel = (map: SeatMap, slot: SlotId, model: string, catalog: SeatModel[]): Edit => assignRow(map, slot, modelRow(catalog, model));
// 其他模型…: an id typed in by the owner. A listed id is its row; any other valid id takes its family from the id.
export const assignCustom = (map: SeatMap, slot: SlotId, model: string, catalog: SeatModel[]): Edit =>
  validModel(model) ? assignRow(map, slot, rowFor(catalog, model)) : { ok: false, reason: 'invalid-id' };

export function swapSlots(map: SeatMap, a: SlotId, b: SlotId, catalog: SeatModel[]): Edit {
  const first = getSlot(map, a), second = getSlot(map, b), rows = [first, second].map(seat => seat && modelRow(catalog, seat.model));
  if (!first || !second || !rows[0] || !rows[1]) return { ok: false, reason: 'unknown-model' };
  if (a === b || first.model === second.model && sameSeat(first, second)) return { ok: false, reason: 'same' };
  return { ok: true, map: withSlot(withSlot(map, a, fitSeat(second, rows[1], !!first.ultracode)), b, fitSeat(first, rows[0], !!second.ultracode)) };
}

export function setEffort(map: SeatMap, slot: SlotId, effort: string, catalog: SeatModel[]): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  const efforts = rowFor(catalog, seat.model)?.efforts ?? BASE_EFFORTS[familyOf(seat.model)];
  return efforts.includes(effort) ? { ok: true, map: withSlot(map, slot, { ...seat, effort }) } : { ok: false, reason: 'effort' };
}

// Fast turns on only where the model's row says so; turning it off is always allowed.
export function setFast(map: SeatMap, slot: SlotId, fast: boolean, catalog: SeatModel[]): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  return !fast || rowFor(catalog, seat.model)?.fast ? { ok: true, map: withSlot(map, slot, { ...seat, fast }) } : { ok: false, reason: 'fast' };
}

// The first refusal main would give for this map, or null: 保存 is disabled on it.
export function firstRefusal(map: SeatMap, catalog: SeatModel[]): SeatsSaveError | null {
  const refuse = (code: SeatsSaveError['code'], seat: string, message: string): SeatsSaveError => ({ ok: false, code, seat, message });
  for (const seat of Object.keys(map)) {
    const value = getSlot(map, seat);
    if (!value) continue;
    const family = familyOf(value.model);
    const row = rowFor(catalog, value.model);
    if (!(row?.efforts ?? BASE_EFFORTS[family]).includes(value.effort)) return refuse('invalid-effort', seat, unsupportedEffort(family));
    if (value.fast && !row?.fast) return refuse('fast-not-allowed', seat, 'This model has no fast mode.');
  }
  return null;
}

// The seats whose slots differ between two maps, in the skill's own order.
export const changedSeats = (seats: SeatId[], working: SeatMap, baseline: SeatMap) =>
  seats.filter(id => !sameSeat(getSlot(working, id), getSlot(baseline, id)));
// An unavailable seat can use its default instead.
export function fallbackFor(info: SeatsInfo, slot: SlotId, working: SeatMap): Seat | null {
  const seat = getSlot(working, slot);
  if (!seat || isAvailable(info.catalog, seat.model)) return null;
  const fallback = getSlot(info.defaults, slot);
  return fallback && isAvailable(info.catalog, fallback.model) ? fallback : null;
}

type SeatsApi = Pick<Window['agentrix'], 'setSkillRouting'>;

export async function saveSeats(api: SeatsApi, scope: Scope, projectId: string | null, config: RoutingConfig, base: string | null) {
  try {
    const result = await api.setSkillRouting(scope, scope === 'project' ? projectId : null, config, scope === 'project' ? base : null);
    return result.ok ? { ok: true as const } : { ok: false as const, message: result.message, error: result };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
}

// 模型盘: the catalog grouped by family and then by model line, the line read from the id (never from a list of names, so a new line shows up by itself). Each line shows its aliases
// and its newest version first; older versions fold away. A search keeps only the matching rows.
type PaletteLine = { name: string; shown: SeatModel[]; older: SeatModel[] };
type PaletteGroup = { family: Family; total: number; lines: PaletteLine[] };
const idVersion = (model: string): number[] => (model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').match(/\d+(?:\.\d+)*/g) ?? []).flatMap(part => part.split('.').map(Number));
const versionNewer = (a: number[], b: number[]) => { for (let at = 0; at < Math.max(a.length, b.length); at++) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) > (b[at] ?? 0); return false; };
const isAliasRow = (row: SeatModel) => row.source === 'alias' || /^[a-z]+$/i.test(row.model);
// The line is the first word of the id that is not the vendor prefix or a number ("claude-opus-5" and "opus" are Opus, "gpt-6.2-sol" is Sol, "gpt-5.5" has none).
export function lineOf(row: SeatModel): string {
  const word = row.model.replace(/\[[^\]]*\]$/, '').split(/[-_\s.:/]+/).find(part => /^[a-z]/i.test(part) && !/^(gpt|claude)$/i.test(part));
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : '';
}
export function paletteGroups(catalog: SeatModel[], query = ''): PaletteGroup[] {
  const q = query.trim().toLowerCase(), match = (row: SeatModel) => !q || row.label.toLowerCase().includes(q) || row.model.toLowerCase().includes(q);
  const groups = (['claude', 'codex'] as Family[]).map(family => {
    const rows = catalog.filter(row => row.family === family), names: string[] = [], byLine = new Map<string, SeatModel[]>();
    for (const row of rows) { const name = lineOf(row); if (!byLine.has(name)) { byLine.set(name, []); names.push(name); } byLine.get(name)!.push(row); }
    names.sort((a, b) => Number(a === '') - Number(b === ''));
    const lines = names.map(name => {
      const all = byLine.get(name)!, versions = all.filter(row => !isAliasRow(row)).map(row => idVersion(row.model)).filter(version => version.length);
      const top = versions.reduce<number[]>((best, version) => versionNewer(version, best) ? version : best, []);
      const current = (row: SeatModel) => isAliasRow(row) || !idVersion(row.model).length || (!versionNewer(idVersion(row.model), top) && !versionNewer(top, idVersion(row.model)));
      const weight = (row: SeatModel) => isAliasRow(row) ? 0 : idVersion(row.model).length ? 2 : 1;
      // An alias and the release it runs read the same; the release stays.
      const shown = all.filter(current).filter(row => !(isAliasRow(row) && aliasTarget(catalog, row.model))).sort((a, b) => weight(a) - weight(b));
      const older = all.filter(row => !current(row)).sort((a, b) => versionNewer(idVersion(a.model), idVersion(b.model)) ? -1 : versionNewer(idVersion(b.model), idVersion(a.model)) ? 1 : 0);
      return { name, shown: shown.filter(match), older: older.filter(match) };
    }).filter(line => line.shown.length || line.older.length);
    return { family, total: rows.filter(row => !(isAliasRow(row) && aliasTarget(catalog, row.model))).length, lines };
  });
  return q ? groups.filter(group => group.lines.length) : groups;
}

type CallRole = SeatRole & { source?: TeamRole['source'] };
const DEVELOPER_ROLE: CallRole = { id: 'developer', name: 'Developer', duty: '', detail: '', outputs: '' };

export function callSeatRole(roles: readonly CallRole[], item: CallRow['item']) {
  const knownRole = roles.find(role => role.id === item.seat);
  const fallback = roles.find(role => role.id === DEVELOPER_ROLE.id) ?? DEVELOPER_ROLE;
  const named = item.seat && (item.seatName || item.offTeam);
  const role = named ? { ...(knownRole ?? DEVELOPER_ROLE), id: item.seat!, name: item.seatName ?? knownRole?.name ?? item.seat! } : knownRole ?? fallback;
  return { role, inferred: item.seatSource !== 'declared' || !knownRole && !item.seatName && !item.offTeam };
}

export function roleGroups(roles: readonly CallRole[], rows: CallRow[], selectedRoles = roles) {
  const groups = new Map<string, { role: CallRole; rows: CallRow[]; offTeam: boolean; newest: number; recordedName: boolean }>();
  for (const row of rows) {
    const { role } = callSeatRole(roles, row.item);
    const offTeam = !!row.item.offTeam, key = JSON.stringify([role.id, offTeam]);
    const selected = selectedRoles.find(candidate => candidate.id === role.id);
    const name = selected?.name ?? role.name, started = row.item.startedAt ?? -1;
    const recordedName = !selected && !!row.item.seatName;
    const group = groups.get(key);
    if (!group) groups.set(key, { role: { ...(selected ?? role), name }, rows: [row], offTeam, newest: started, recordedName });
    else {
      group.rows.push(row);
      if (!selected && started > group.newest) { group.role = role; group.newest = started; group.recordedName = recordedName; }
    }
  }
  const order = new Map(selectedRoles.map((role, index) => [role.id, index]));
  const rank = (id: string) => order.get(id) ?? selectedRoles.length;
  return [...groups.values()].sort((a, b) => Number(a.offTeam) - Number(b.offTeam) || rank(a.role.id) - rank(b.role.id));
}

export function routeVerdict(row: CallRow, info?: SeatsInfo | null) {
  const { call, item } = row, declared = item.declared;
  // Main supplies this snapshot for new calls. Older call items have no seat verdict.
  const { expected } = item as typeof item & { expected?: Required<Seat> | null };
  if (item.offTeam || !call.model || call.modelUnconfirmed) return 'unknown';
  const matches = (model: string) => sameModel(info?.catalog ?? [], model, call.model!);
  const differs = (settings: NonNullable<typeof declared>) => !matches(settings.model)
    || settings.effort != null && call.effort != null && settings.effort !== call.effort
    || settings.fast != null && call.fast != null && settings.fast !== call.fast;
  if (expected && differs(expected) || declared && differs(declared)) return 'mismatch';
  if (declared && (declared.effort != null && call.effort == null || declared.fast != null && call.fast == null)) return 'unknown';
  return expected || declared ? 'match' : 'unknown';
}
