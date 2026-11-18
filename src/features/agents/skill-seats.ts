import type { Seat, SeatId, SeatMap, SeatModel, SeatsInfo, SeatsSaveError } from '../../shared/types';

// The seats dialog's rules, as pure functions: they mirror electron/features/skills/model-seats.cjs so 保存 can be disabled before main refuses
// (main still validates and its refusal is shown). The catalog carries each model's family, rank and efforts, so nothing here names a model.
export type SlotId = 'lead.claude' | 'lead.codex' | Exclude<SeatId, 'lead'>;
export type Scope = 'global' | 'project';
export type Family = 'claude' | 'codex';
export type Phase = 'plan' | 'build' | 'review' | 'accept';
export type EditRefusal = 'unknown-model' | 'unavailable' | 'family' | 'same' | 'effort' | 'fast';
export type Edit = { ok: true; map: SeatMap } | { ok: false; reason: EditRefusal };
export type ReviewerBlock = { hit: SeatId[]; alternatives: SeatModel[]; fix: SeatModel | null };

const EFFORTS: Record<Family, string[]> = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
// A reviewer must differ from the author seats; the rule compares these.
const AUTHORS: Exclude<SeatId, 'lead'>[] = ['core', 'execution'];
// Which step of the flow a seat belongs to; the dialog's inner ring lights it while the seat is hovered.
export const PHASES: Record<string, Phase> = { architect: 'plan', core: 'build', execution: 'build', reviewer: 'review', visual: 'accept' };

export const familyOf = (model: string): Family => /^(opus|sonnet|haiku|claude-)/.test(model) ? 'claude' : 'codex';
export const slotsOf = (seat: SeatId): SlotId[] => seat === 'lead' ? ['lead.claude', 'lead.codex'] : [seat];
export const seatOfSlot = (slot: SlotId): SeatId => slot.startsWith('lead.') ? 'lead' : slot as SeatId;
// A lead slot holds only its own agent's family; every other seat takes any.
export const slotFamily = (slot: SlotId): Family | null => slot === 'lead.claude' ? 'claude' : slot === 'lead.codex' ? 'codex' : null;
export const getSlot = (map: SeatMap, slot: SlotId): Seat | undefined => slot === 'lead.claude' ? map.lead?.claude : slot === 'lead.codex' ? map.lead?.codex : map[slot];
export const withSlot = (map: SeatMap, slot: SlotId, seat: Seat): SeatMap => slot.startsWith('lead.') ? { ...map, lead: { ...map.lead, [slot.slice(5)]: seat } } : { ...map, [slot]: seat };
export const sameSeat = (a?: Seat, b?: Seat) => !!a && !!b && a.model === b.model && a.effort === b.effort && !!a.fast === !!b.fast;
export const modelRow = (catalog: SeatModel[], model: string) => catalog.find(row => row.model === model);
// A model the catalog does not know is not judged unavailable.
export const isAvailable = (catalog: SeatModel[], model: string) => modelRow(catalog, model)?.available !== false;
const rankOf = (catalog: SeatModel[], model: string) => modelRow(catalog, model)?.rank ?? (familyOf(model) === 'codex' ? 3 : /sonnet/.test(model) ? 2 : /haiku/.test(model) ? 1 : 3);

// defaults ← global ← project, seat by seat (the lead's two slots too).
export function mergeSeats(...layers: (SeatMap | null | undefined)[]): SeatMap {
  const merged: SeatMap = {};
  for (const layer of layers) if (layer) for (const [id, seat] of Object.entries(layer)) Object.assign(merged, { [id]: id === 'lead' ? { ...merged.lead, ...seat } : seat });
  return merged;
}

// What a scope's save starts from, and the layer under it: the owner's choice is only what differs from that layer.
export const lowerLayer = (info: SeatsInfo, scope: Scope): SeatMap => scope === 'project' ? mergeSeats(info.defaults, info.global) : info.defaults;
export const baselineFor = (info: SeatsInfo, scope: Scope): SeatMap => scope === 'project' ? mergeSeats(info.defaults, info.global, info.project) : mergeSeats(info.defaults, info.global);
export const startScope = (info: SeatsInfo, projectId?: string): Scope => projectId && info.project && Object.keys(info.project).length ? 'project' : 'global';

// A seat's model moved into another seat keeps its effort and fast only where the new model allows them.
function fitSeat(seat: Seat, row: SeatModel): Seat {
  const effort = row.efforts.includes(seat.effort) ? seat.effort : row.efforts.includes('high') ? 'high' : row.efforts[row.efforts.length - 1];
  return row.family === 'codex' && row.fast ? { model: row.model, effort, fast: seat.fast ?? true } : { model: row.model, effort };
}

export function assignModel(map: SeatMap, slot: SlotId, model: string, catalog: SeatModel[]): Edit {
  const row = modelRow(catalog, model), current = getSlot(map, slot);
  if (!row) return { ok: false, reason: 'unknown-model' };
  if (!row.available) return { ok: false, reason: 'unavailable' };
  if (slotFamily(slot) && slotFamily(slot) !== row.family) return { ok: false, reason: 'family' };
  if (current?.model === model) return { ok: false, reason: 'same' };
  return { ok: true, map: withSlot(map, slot, fitSeat(current ?? { model, effort: 'high' }, row)) };
}

export function swapSlots(map: SeatMap, a: SlotId, b: SlotId, catalog: SeatModel[]): Edit {
  const first = getSlot(map, a), second = getSlot(map, b), rows = [first, second].map(seat => seat && modelRow(catalog, seat.model));
  if (!first || !second || !rows[0] || !rows[1]) return { ok: false, reason: 'unknown-model' };
  if (a === b || first.model === second.model && sameSeat(first, second)) return { ok: false, reason: 'same' };
  if (slotFamily(a) && slotFamily(a) !== rows[1].family || slotFamily(b) && slotFamily(b) !== rows[0].family) return { ok: false, reason: 'family' };
  return { ok: true, map: withSlot(withSlot(map, a, fitSeat(second, rows[1])), b, fitSeat(first, rows[0])) };
}

export function setEffort(map: SeatMap, slot: SlotId, effort: string): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  return EFFORTS[familyOf(seat.model)].includes(effort) ? { ok: true, map: withSlot(map, slot, { ...seat, effort }) } : { ok: false, reason: 'effort' };
}

export function setFast(map: SeatMap, slot: SlotId, fast: boolean): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  return familyOf(seat.model) === 'codex' ? { ok: true, map: withSlot(map, slot, { ...seat, fast }) } : { ok: false, reason: 'fast' };
}

// The reviewer rule: refused when the reviewer runs the core's or the execution seat's model while another AVAILABLE model of at least its rank exists.
// The fix is such a model that none of the author seats runs, or null when the author seats themselves must change.
export function reviewerBlock(map: SeatMap, catalog: SeatModel[]): ReviewerBlock | null {
  const reviewer = map.reviewer;
  const hit = reviewer ? AUTHORS.filter(id => map[id]?.model === reviewer.model) : [];
  if (!reviewer || !hit.length) return null;
  const alternatives = catalog.filter(row => row.available && row.model !== reviewer.model && row.rank >= rankOf(catalog, reviewer.model));
  if (!alternatives.length) return null;
  return { hit, alternatives, fix: alternatives.find(row => AUTHORS.every(id => map[id]?.model !== row.model)) ?? null };
}
// The same reviewer rule when it only warns: the author seats share the reviewer's model but nothing at least as strong is available to change it to.
export const reviewerSameButAllowed = (map: SeatMap, catalog: SeatModel[]) =>
  !!map.reviewer && !reviewerBlock(map, catalog) && AUTHORS.some(id => map[id]?.model === map.reviewer?.model);

// The first refusal main would give for this map, or null: 保存 is disabled on it.
export function firstRefusal(map: SeatMap, catalog: SeatModel[]): SeatsSaveError | null {
  const refuse = (code: SeatsSaveError['code'], seat: string, message: string): SeatsSaveError => ({ ok: false, code, seat, message });
  for (const seat of ['lead.claude', 'lead.codex', ...Object.keys(map).filter(id => id !== 'lead')] as SlotId[]) {
    const value = getSlot(map, seat);
    if (!value) continue;
    const family = familyOf(value.model);
    if (slotFamily(seat) && slotFamily(seat) !== family) return refuse('lead-family', seat, `The ${seat} slot requires a ${slotFamily(seat)} model.`);
    if (!EFFORTS[family].includes(value.effort)) return refuse('invalid-effort', seat, `Unsupported ${family} effort.`);
    if (value.fast && family !== 'codex') return refuse('fast-not-allowed', seat, 'Fast mode is available only for GPT seats.');
  }
  return reviewerBlock(map, catalog) && refuse('reviewer-same-model', 'reviewer', 'Choose a reviewer different from core and execution when another available model is at least as strong.');
}

// The seats whose slots differ between two maps, in the skill's own order.
export const changedSeats = (seats: SeatId[], working: SeatMap, baseline: SeatMap) =>
  seats.filter(id => slotsOf(id).some(slot => !sameSeat(getSlot(working, slot), getSlot(baseline, slot))));
export const changedCount = (seats: SeatId[], working: SeatMap, baseline: SeatMap) => changedSeats(seats, working, baseline).length;
export const isEmptyMap = (map: SeatMap) => !Object.keys(map).length;
// An unavailable model's seat runs its default instead (a lead slot has none: its agent is not installed).
export function fallbackFor(info: SeatsInfo, slot: SlotId, working: SeatMap): Seat | null {
  const seat = getSlot(working, slot);
  if (!seat || isAvailable(info.catalog, seat.model) || slot.startsWith('lead.')) return null;
  const fallback = getSlot(info.defaults, slot);
  return fallback && isAvailable(info.catalog, fallback.model) ? fallback : null;
}

// Only the seats that differ from the layer under the scope are saved; no difference is an empty map, which clears the scope (恢复默认).
export function scopePayload(working: SeatMap, lower: SeatMap): SeatMap {
  let payload: SeatMap = {};
  for (const id of Object.keys(working) as SeatId[]) for (const slot of slotsOf(id)) {
    const seat = getSlot(working, slot);
    if (seat && !sameSeat(seat, getSlot(lower, slot))) payload = withSlot(payload, slot, seat);
  }
  return payload;
}

type SeatsApi = Pick<Window['agentrix'], 'setSkillSeats'>;
// One save: the chosen scope and the edited map. A refusal or a failed call comes back as its message, never thrown.
export async function saveSeats(api: SeatsApi, scope: Scope, projectId: string | null, working: SeatMap, lower: SeatMap): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await api.setSkillSeats(scope, scope === 'project' ? projectId : null, scopePayload(working, lower));
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
