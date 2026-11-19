import type { CallRow } from './subagent-splits.ts';
import type { OperationId, OperationMap, OperationRow, OperationValue, Seat, SeatId, SeatIssue, SeatMap, SeatModel, SeatRole, SeatsInfo, SeatsSaveError } from '../../shared/types';
import { BASE_EFFORTS, familyOf, rankByName, unsupportedEffort, validModel } from '../../../electron/features/skills/seat-rules.mjs';

export { familyOf };

// The dialog checks seat edits before saving. Main still validates saves and the dialog shows its refusal.
export type SlotId = SeatId;
export type Scope = 'global' | 'project';
type Family = 'claude' | 'codex';
type EditRefusal = 'unknown-model' | 'unavailable' | 'same' | 'effort' | 'fast' | 'invalid-id';
export type Edit = { ok: true; map: SeatMap } | { ok: false; reason: EditRefusal };
type ReviewerBlock = { hit: SeatId[]; alternatives: SeatModel[]; fix: SeatModel | null };

const AUTHORS: SeatId[] = ['developer'];

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
export const sameSeat = (a?: Seat, b?: Seat) => !!a && !!b && a.model === b.model && a.effort === b.effort && !!a.fast === !!b.fast;
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
// The few alternatives the blocked-reviewer banner names, strongest first, and how many there are in all.
// The blocked banner names the alternatives in the order the one-click fix prefers them (the fix first), one per model line (the alias, else the newest version, not every old one).
export function topAlternatives(alternatives: SeatModel[], max = 3, ctx?: { fix: SeatModel | null; map: SeatMap; catalog: SeatModel[]; defaults?: SeatMap }) {
  const preferred = (a: SeatModel, b: SeatModel) => Number(isAliasRow(b)) - Number(isAliasRow(a)) || (versionNewer(idVersion(a.model), idVersion(b.model)) ? -1 : versionNewer(idVersion(b.model), idVersion(a.model)) ? 1 : 0);
  const lineKey = (row: SeatModel) => row.family + lineOf(row), best = new Map<string, SeatModel>();
  for (const row of [...alternatives].sort(preferred)) if (!best.has(lineKey(row))) best.set(lineKey(row), row);
  const lines = [...best.values()], ordered = ctx ? orderSuggestions(lines, ctx.map, ctx.catalog, ctx.defaults) : [...lines].sort(strength);
  const fix = ctx?.fix, shown = fix ? [fix, ...ordered.filter(row => lineKey(row) !== lineKey(fix))] : ordered;
  return { shown: shown.slice(0, max), total: alternatives.length };
}
// A typed-in id the catalog does not list: its family comes from the id, its efforts from the family's base list, fast only where Codex can apply it.
const customRow = (model: string): SeatModel => {
  const family = familyOf(model);
  return { model, label: model, family, efforts: BASE_EFFORTS[family], fast: family === 'codex',
    ...(family === 'codex' ? {} : { fastReason: 'unknown' as const }), rank: rankByName(model), available: true, source: 'custom' };
};
// The catalog's row, or the row a valid typed-in id would get.
export const rowFor = (catalog: SeatModel[], model: string) => modelRow(catalog, model) ?? (validModel(model) ? customRow(model) : undefined);
const rankOf = (catalog: SeatModel[], model: string) => rowFor(catalog, model)?.rank ?? rankByName(model);
// The issues main reported for a slot.
export const issuesOf = (info: SeatsInfo, slot: SlotId): SeatIssue[] => (info.issues ?? []).filter(issue => issue.slot === slot);
// How long ago a model list was read, as a unit and a count for the dialog to word.
export function ageOf(at: number | null, now: number): { unit: 'never' | 'now' | 'min' | 'hour' | 'day'; count: number } {
  if (!at) return { unit: 'never', count: 0 };
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? { unit: 'now', count: 0 } : minutes < 60 ? { unit: 'min', count: minutes } : minutes < 2880 ? { unit: 'hour', count: Math.floor(minutes / 60) } : { unit: 'day', count: Math.floor(minutes / 1440) };
}

// defaults ? global ? project, seat by seat.
const mergeSeats = (...layers: (SeatMap | null | undefined)[]): SeatMap => Object.assign({}, ...layers);

// What a scope's save starts from, and the layer under it: the owner's choice is only what differs from that layer.
export const lowerLayer = (info: SeatsInfo, scope: Scope): SeatMap => scope === 'project' ? mergeSeats(info.defaults, info.global) : info.defaults;
export const baselineFor = (info: SeatsInfo, scope: Scope): SeatMap => scope === 'project' ? mergeSeats(info.defaults, info.global, info.project) : mergeSeats(info.defaults, info.global);
export const startScope = (info: SeatsInfo, projectId?: string): Scope =>
  projectId && (Object.keys(info.project ?? {}).length || Object.keys(info.operations?.project ?? {}).length) ? 'project' : 'global';

// A seat's model moved into another seat keeps its effort and fast only where the new model allows them (Claude fast stays off unless the seat already had it).
function fitSeat(seat: Seat, row: SeatModel): Seat {
  const effort = fitEffort(row, seat.effort);
  if (!row.fast) return { model: row.model, effort };
  return { model: row.model, effort, fast: row.family === 'codex' ? seat.fast ?? true : familyOf(seat.model) === 'claude' && !!seat.fast };
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
  return { ok: true, map: withSlot(withSlot(map, a, fitSeat(second, rows[1])), b, fitSeat(first, rows[0])) };
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

// The reviewer rule: refused when the reviewer runs the developer seat's model while another AVAILABLE model of at least its rank exists.
// The fix is such a model that none of the author seats runs, or null when the author seats themselves must change.
const strength = (a: SeatModel, b: SeatModel) => b.rank - a.rank || b.model.localeCompare(a.model, 'en', { numeric: true });
// The candidates in the order the one-click fix and the banner prefer them, never by list order: the reviewer seat's default first, then models another seat already runs, then the rest;
// within each the strongest.
function orderSuggestions(candidates: SeatModel[], map: SeatMap, catalog: SeatModel[], defaults?: SeatMap): SeatModel[] {
  const running = Object.entries(map).filter(([id]) => id !== 'reviewer' && !AUTHORS.includes(id)).map(([, seat]) => seat);
  const tier = (row: SeatModel) => defaults?.reviewer && sameModel(catalog, row.model, defaults.reviewer.model) ? 0 : running.some(seat => sameModel(catalog, seat.model, row.model)) ? 1 : 2;
  return [...candidates].sort((a, b) => tier(a) - tier(b) || strength(a, b));
}
export const pickFix = (candidates: SeatModel[], map: SeatMap, catalog: SeatModel[], defaults?: SeatMap): SeatModel | null => orderSuggestions(candidates, map, catalog, defaults)[0] ?? null;
export function reviewerBlock(map: SeatMap, catalog: SeatModel[], defaults?: SeatMap, identity = canonicalModel): ReviewerBlock | null {
  const reviewer = map.reviewer;
  const keyOf = (model: string) => identity(catalog, model);
  const hit = reviewer ? AUTHORS.filter(id => map[id] && keyOf(map[id]!.model) === keyOf(reviewer.model)) : [];
  if (!reviewer || !hit.length) return null;
  const reviewKey = keyOf(reviewer.model);
  // An alias and the id it resolves to are one model, so neither is an alternative to the other, and they count once.
  const seen = new Set<string>();
  const alternatives = catalog.filter(row => {
    const key = keyOf(row.model);
    if (!row.available || key === reviewKey || row.rank < rankOf(catalog, reviewer.model) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!alternatives.length) return null;
  const fixes = alternatives.filter(row => AUTHORS.every(id => !map[id] || keyOf(map[id]!.model) !== keyOf(row.model)));
  return { hit, alternatives, fix: pickFix(fixes, map, catalog, defaults) };
}

const operationModelIdentity = (catalog: SeatModel[], model: string) => familyOf(model) === 'codex' ? model : canonicalModel(catalog, model);

export function operationReviewerBlock(value: OperationValue | undefined, seats: SeatMap, catalog: SeatModel[], defaults?: SeatMap) {
  if (!value) return null;
  const follow = value === 'follow';
  const reviewer = follow ? seats.reviewer : { model: value.model, effort: 'high' };
  if (!reviewer || familyOf(reviewer.model) !== 'codex') return null;
  const map = { ...seats, reviewer };
  const block = reviewerBlock(map, catalog, defaults, operationModelIdentity);
  if (!block) return null;
  const codex = block.alternatives.filter(row => row.family === 'codex' && familyOf(row.model) === 'codex');
  return { model: reviewer.model, follow, fix: pickFix(codex, map, catalog, defaults) };
}
// The same reviewer rule when it only warns: the author seats share the reviewer's model but nothing at least as strong is available to change it to.
export const reviewerSameButAllowed = (map: SeatMap, catalog: SeatModel[]) =>
  !!map.reviewer && !reviewerBlock(map, catalog) && AUTHORS.some(id => !!map[id] && sameModel(catalog, map[id]!.model, map.reviewer!.model));

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
  return reviewerBlock(map, catalog) && refuse('reviewer-same-model', 'reviewer', 'Choose a reviewer different from developer when another available model is at least as strong.');
}

// The seats whose slots differ between two maps, in the skill's own order.
export const changedSeats = (seats: SeatId[], working: SeatMap, baseline: SeatMap) =>
  seats.filter(id => !sameSeat(getSlot(working, id), getSlot(baseline, id)));
export const changedCount = (seats: SeatId[], working: SeatMap, baseline: SeatMap) => changedSeats(seats, working, baseline).length;
// An unavailable seat can use its default instead.
export function fallbackFor(info: SeatsInfo, slot: SlotId, working: SeatMap): Seat | null {
  const seat = getSlot(working, slot);
  if (!seat || isAvailable(info.catalog, seat.model)) return null;
  const fallback = getSlot(info.defaults, slot);
  return fallback && isAvailable(info.catalog, fallback.model) ? fallback : null;
}

// Only the seats that differ from the layer under the scope are saved; no difference is an empty map, which clears the scope (恢复默认).
export function scopePayload(working: SeatMap, lower: SeatMap): SeatMap {
  return Object.fromEntries(Object.entries(working).filter(([id, seat]) => !sameSeat(seat, getSlot(lower, id))));
}

type SeatsApi = Pick<Window['agentrix'], 'setSkillSeats'>;
// One save: the chosen scope and the edited map. A refusal or a failed call comes back as its message, never thrown.
export async function saveSeats(
  api: SeatsApi, scope: Scope, projectId: string | null, working: SeatMap, lower: SeatMap, operations?: OperationMap,
): Promise<{ ok: true } | { ok: false; message: string; error?: SeatsSaveError }> {
  try {
    const args = [scope, scope === 'project' ? projectId : null, scopePayload(working, lower)] as const;
    const result = operations === undefined ? await api.setSkillSeats(...args) : await api.setSkillSeats(...args, operations);
    return result.ok ? { ok: true } : { ok: false, message: result.message, ...(result.operation ? { error: result } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export const sameOperation = (a?: OperationValue, b?: OperationValue) =>
  a === b || (!!a && !!b && a !== 'follow' && b !== 'follow' && a.model === b.model && a.effort === b.effort);

export function operationLayers(operations: SeatsInfo['operations'], scope: Scope) {
  const global = { ...operations?.defaults, ...operations?.global };
  return scope === 'project' ? { lower: global, baseline: { ...global, ...operations?.project } } : { lower: operations?.defaults ?? {}, baseline: global };
}

export function operationDiff(values: OperationMap, base: OperationMap): OperationMap {
  return Object.fromEntries(Object.entries(values).filter(([id, value]) => !sameOperation(value, base[id as OperationId])));
}

export const operationUsesEffort = (row: OperationRow, family: Family) => row.effort === 'always' || (row.effort === 'codex' && family === 'codex');

export function operationFamilyReason(row: OperationRow, family: Family) {
  if (row.families.includes(family)) return '';
  return row.families.includes('claude') ? '此操作只能用 Claude 模型' : '此操作只能用 Codex 模型';
}

export function operationAssignment(row: OperationRow, model: string, catalog: SeatModel[], previous?: OperationValue) {
  const choice = rowFor(catalog, model);
  if (!choice) return { reason: '模型名只能含字母、数字和 . : @ + / [ ] - _，以字母或数字开头，最多 160 个字符' };
  const family = operationFamilyReason(row, choice.family);
  if (family || !choice.available) return { reason: family || choice.reason || '不可用' };
  const effort = operationUsesEffort(row, choice.family) ? fitEffort(choice, previous === 'follow' ? undefined : previous?.effort) : undefined;
  return { value: effort ? { model, effort } : { model } };
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
      const shown = all.filter(current).sort((a, b) => weight(a) - weight(b));
      const older = all.filter(row => !current(row)).sort((a, b) => versionNewer(idVersion(a.model), idVersion(b.model)) ? -1 : versionNewer(idVersion(b.model), idVersion(a.model)) ? 1 : 0);
      return { name, shown: shown.filter(match), older: older.filter(match) };
    }).filter(line => line.shown.length || line.older.length);
    return { family, total: rows.length, lines };
  });
  return q ? groups.filter(group => group.lines.length) : groups;
}

const DEVELOPER_ROLE: SeatRole = { id: 'developer', name: 'Developer', duty: '', detail: '', outputs: '' };

export function callSeatRole(roles: readonly SeatRole[], item: CallRow['item']) {
  const knownRole = roles.find(role => role.id === item.seat);
  const role = knownRole ?? roles.find(role => role.id === DEVELOPER_ROLE.id) ?? DEVELOPER_ROLE;
  return { role, inferred: !knownRole || item.seatSource !== 'declared' };
}

export function roleGroups(roles: readonly SeatRole[], rows: CallRow[]) {
  const groups = new Map<SeatRole, CallRow[]>(roles.map(role => [role, []]));
  for (const row of rows) {
    const { role } = callSeatRole(roles, row.item);
    const group = groups.get(role);
    if (group) group.push(row); else groups.set(role, [row]);
  }
  return Array.from(groups, ([role, rows]) => ({ role, rows })).filter(group => group.rows.length > 0);
}

export function routeVerdict(row: CallRow, info?: SeatsInfo | null) {
  const { call, item } = row, declared = item.declared;
  const expected = item.seatSource === 'declared' && item.seat ? info?.current?.[item.seat] : undefined;
  if (!call.model || call.modelUnconfirmed) return 'unknown';
  const matches = (model: string) => sameModel(info?.catalog ?? [], model, call.model!);
  if (expected && !matches(expected.model)) return 'mismatch';
  if (declared) {
    if (!matches(declared.model) || declared.effort != null && call.effort != null && declared.effort !== call.effort
      || declared.fast != null && call.fast != null && declared.fast !== call.fast) return 'mismatch';
    if (declared.effort != null && call.effort == null || declared.fast != null && call.fast == null) return 'unknown';
  }
  return expected || declared ? 'match' : 'unknown';
}
