import type { Seat, SeatId, SeatIssue, SeatMap, SeatModel, SeatsInfo, SeatsSaveError } from '../../shared/types';

// The seats dialog's rules, as pure functions: they mirror electron/features/skills/model-seats.cjs so 保存 can be disabled before main refuses
// (main still validates and its refusal is shown). The catalog carries each model's family, rank and efforts, so nothing here names a model.
export type SlotId = 'lead.claude' | 'lead.codex' | Exclude<SeatId, 'lead'>;
export type Scope = 'global' | 'project';
export type Family = 'claude' | 'codex';
export type Phase = 'plan' | 'build' | 'review' | 'accept';
export type EditRefusal = 'unknown-model' | 'unavailable' | 'family' | 'same' | 'effort' | 'fast' | 'invalid-id';
export type Edit = { ok: true; map: SeatMap } | { ok: false; reason: EditRefusal };
export type ReviewerBlock = { hit: SeatId[]; alternatives: SeatModel[]; fix: SeatModel | null };

// The base lists apply to a model the catalog does not know (an id typed in by the owner).
const EFFORTS: Record<Family, string[]> = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['low', 'medium', 'high', 'xhigh'] };
// A reviewer must differ from the author seats; the rule compares these.
const AUTHORS: Exclude<SeatId, 'lead'>[] = ['core', 'execution'];
// Which step of the flow a seat belongs to; the dialog's inner ring lights it while the seat is hovered.
export const PHASES: Record<string, Phase> = { architect: 'plan', core: 'build', execution: 'build', reviewer: 'review', visual: 'accept' };

// Where each seat's tile stands on the table (plane coordinates). A tile stands upright above its plane point, whose y the tilt flattens by cos(tilt), so overlap is judged on the screen
// rectangles. The seven fixed seats have set spots (checked clear of each other and of the wide lead tile); a seat without one goes on the rim and slides outward off the lead tile.
export const TILT = 55;
export type SeatSpot = { x: number; y: number; w: number; h: number };
const SPOTS: Partial<Record<SeatId, SeatSpot>> = {
  lead: { x: 0, y: -330, w: 500, h: 150 }, architect: { x: 388, y: -168, w: 248, h: 120 }, reviewer: { x: -388, y: -168, w: 248, h: 120 }, core: { x: 404, y: 92, w: 248, h: 120 },
  lookup: { x: -404, y: 92, w: 248, h: 120 }, execution: { x: 140, y: 268, w: 248, h: 120 }, visual: { x: -140, y: 268, w: 248, h: 120 },
};
const flat = Math.cos(TILT * Math.PI / 180);
export const spotsTouch = (a: SeatSpot, b: SeatSpot, gap: number) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && a.y * flat - a.h < b.y * flat + gap && b.y * flat - b.h < a.y * flat + gap;
export function seatLayout(ids: SeatId[]): Record<string, SeatSpot> {
  const spots: Record<string, SeatSpot> = {};
  ids.forEach((id, index) => {
    const known = SPOTS[id];
    if (known) { spots[id] = known; return; }
    const angle = (-90 + index * 360 / ids.length) * Math.PI / 180;
    let spot: SeatSpot = { x: Math.round(Math.cos(angle) * 410), y: Math.round(Math.sin(angle) * 270), w: 248, h: 120 };
    const lead = SPOTS.lead!;
    while (ids.includes('lead') && spotsTouch(spot, lead, 12) && Math.abs(spot.x) + spot.w / 2 < 560) spot = { ...spot, x: spot.x + (spot.x < 0 ? -4 : 4) };
    spots[id] = spot;
  });
  return spots;
}
// A shorter name for a small tile: "Opus (follows latest)" is "Opus (latest)"; the menu and the list keep the full text.
export const shortLabel = (label: string) => label.replace(/\s*\(follows latest\)$/i, ' (latest)');
// The table's size (the 1130 x 700 stage), and the scale that fits it in the width and in the height left by the rest of the dialog.
export const STAGE_W = 1130, STAGE_H = 700;
export const sceneScale = (width: number, space: number) => Math.max(0.5, Math.min(1, width / STAGE_W, space / STAGE_H));
// Where the 更换 menu goes: under its button, else above it, else on the roomier side; it never leaves the viewport, and the model list scrolls inside it (maxHeight).
export function menuPlacement(anchor: { left: number; top: number; bottom: number }, view: { width: number; height: number }, rows: number): { left: number; top?: number; bottom?: number; maxHeight: number } {
  const need = Math.min(rows * 32 + 200, view.height - 16), below = view.height - anchor.bottom - 12, above = anchor.top - 12;
  const left = Math.max(8, Math.min(view.width - 288, Math.round(anchor.left)));
  const under = { left, top: Math.round(anchor.bottom + 4), maxHeight: Math.max(below, 0) }, over = { left, bottom: Math.round(view.height - anchor.top + 4), maxHeight: Math.max(above, 0) };
  return need <= below ? under : need <= above ? over : below >= above ? under : over;
}
export const familyOf = (model: string): Family => /^(opus|sonnet|haiku|claude-)/.test(model) ? 'claude' : 'codex';
// The id syntax the dispatch helper takes for --model (integration/dispatch.cjs), at most 160 characters.
export const MODEL_ID = /^[A-Za-z0-9][\w.:@+/[\]-]*$/;
export const isModelId = (model: string) => model.length <= 160 && MODEL_ID.test(model);
// The rank rule for a model without a provider tier (parity fixture: tests/fixtures/seat-ranks.json).
export const rankByName = (model: string): 1 | 2 | 3 => /(^|[-_.])(haiku|mini|nano|lite)([-_.]|$)/.test(model) ? 1 : /(^|[-_.])sonnet([-_.]|$)/.test(model) ? 2 : 3;
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
  for (const row of catalog) if (TIER.exec(bare(row.model))?.[1] === id && (!best || newer(versionOf(row.model), versionOf(best)))) best = row.model;
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
export const customRow = (model: string): SeatModel => {
  const family = familyOf(model);
  return { model, label: model, family, efforts: EFFORTS[family], fast: family === 'codex', ...(family === 'codex' ? {} : { fastReason: 'unknown' as const }), rank: rankByName(model), available: true, source: 'custom' };
};
// The catalog's row, or the row a valid typed-in id would get.
export const rowFor = (catalog: SeatModel[], model: string) => modelRow(catalog, model) ?? (isModelId(model) ? customRow(model) : undefined);
const rankOf = (catalog: SeatModel[], model: string) => rowFor(catalog, model)?.rank ?? rankByName(model);
// The issues main reported for a slot.
export const issuesOf = (info: SeatsInfo, slot: SlotId): SeatIssue[] => (info.issues ?? []).filter(issue => issue.slot === slot);
// How long ago a model list was read, as a unit and a count for the dialog to word.
export function ageOf(at: number | null, now: number): { unit: 'never' | 'now' | 'min' | 'hour' | 'day'; count: number } {
  if (!at) return { unit: 'never', count: 0 };
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? { unit: 'now', count: 0 } : minutes < 60 ? { unit: 'min', count: minutes } : minutes < 2880 ? { unit: 'hour', count: Math.floor(minutes / 60) } : { unit: 'day', count: Math.floor(minutes / 1440) };
}

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

// A seat's model moved into another seat keeps its effort and fast only where the new model allows them (Claude fast stays off unless the seat already had it).
function fitSeat(seat: Seat, row: SeatModel): Seat {
  const effort = row.efforts.includes(seat.effort) ? seat.effort : row.defaultEffort && row.efforts.includes(row.defaultEffort) ? row.defaultEffort : row.efforts.includes('high') ? 'high' : row.efforts[row.efforts.length - 1];
  if (!row.fast) return { model: row.model, effort };
  return { model: row.model, effort, fast: row.family === 'codex' ? seat.fast ?? true : familyOf(seat.model) === 'claude' && !!seat.fast };
}

function assignRow(map: SeatMap, slot: SlotId, row: SeatModel | undefined): Edit {
  const current = getSlot(map, slot);
  if (!row) return { ok: false, reason: 'unknown-model' };
  if (!row.available) return { ok: false, reason: 'unavailable' };
  if (slotFamily(slot) && slotFamily(slot) !== row.family) return { ok: false, reason: 'family' };
  if (current?.model === row.model) return { ok: false, reason: 'same' };
  return { ok: true, map: withSlot(map, slot, fitSeat(current ?? { model: row.model, effort: 'high' }, row)) };
}
export const assignModel = (map: SeatMap, slot: SlotId, model: string, catalog: SeatModel[]): Edit => assignRow(map, slot, modelRow(catalog, model));
// 其他模型…: an id typed in by the owner. A listed id is its row; any other valid id takes its family from the id.
export const assignCustom = (map: SeatMap, slot: SlotId, model: string, catalog: SeatModel[]): Edit => isModelId(model) ? assignRow(map, slot, rowFor(catalog, model)) : { ok: false, reason: 'invalid-id' };

export function swapSlots(map: SeatMap, a: SlotId, b: SlotId, catalog: SeatModel[]): Edit {
  const first = getSlot(map, a), second = getSlot(map, b), rows = [first, second].map(seat => seat && modelRow(catalog, seat.model));
  if (!first || !second || !rows[0] || !rows[1]) return { ok: false, reason: 'unknown-model' };
  if (a === b || first.model === second.model && sameSeat(first, second)) return { ok: false, reason: 'same' };
  if (slotFamily(a) && slotFamily(a) !== rows[1].family || slotFamily(b) && slotFamily(b) !== rows[0].family) return { ok: false, reason: 'family' };
  return { ok: true, map: withSlot(withSlot(map, a, fitSeat(second, rows[1])), b, fitSeat(first, rows[0])) };
}

export function setEffort(map: SeatMap, slot: SlotId, effort: string, catalog: SeatModel[]): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  return (rowFor(catalog, seat.model)?.efforts ?? EFFORTS[familyOf(seat.model)]).includes(effort) ? { ok: true, map: withSlot(map, slot, { ...seat, effort }) } : { ok: false, reason: 'effort' };
}

// Fast turns on only where the model's row says so; turning it off is always allowed.
export function setFast(map: SeatMap, slot: SlotId, fast: boolean, catalog: SeatModel[]): Edit {
  const seat = getSlot(map, slot);
  if (!seat) return { ok: false, reason: 'unknown-model' };
  return !fast || rowFor(catalog, seat.model)?.fast ? { ok: true, map: withSlot(map, slot, { ...seat, fast }) } : { ok: false, reason: 'fast' };
}

// The reviewer rule: refused when the reviewer runs the core's or the execution seat's model while another AVAILABLE model of at least its rank exists.
// The fix is such a model that none of the author seats runs, or null when the author seats themselves must change.
const strength = (a: SeatModel, b: SeatModel) => b.rank - a.rank || b.model.localeCompare(a.model, 'en', { numeric: true });
// The candidates in the order the one-click fix and the banner prefer them, never by list order: the reviewer seat's default first, then models another seat already runs, then the rest;
// within each the strongest.
export function orderSuggestions(candidates: SeatModel[], map: SeatMap, catalog: SeatModel[], defaults?: SeatMap): SeatModel[] {
  const running = [map.lead?.claude, map.lead?.codex, map.architect, map.execution, map.visual, map.lookup].filter((seat): seat is Seat => !!seat);
  const tier = (row: SeatModel) => defaults?.reviewer && sameModel(catalog, row.model, defaults.reviewer.model) ? 0 : running.some(seat => sameModel(catalog, seat.model, row.model)) ? 1 : 2;
  return [...candidates].sort((a, b) => tier(a) - tier(b) || strength(a, b));
}
export const pickFix = (candidates: SeatModel[], map: SeatMap, catalog: SeatModel[], defaults?: SeatMap): SeatModel | null => orderSuggestions(candidates, map, catalog, defaults)[0] ?? null;
export function reviewerBlock(map: SeatMap, catalog: SeatModel[], defaults?: SeatMap): ReviewerBlock | null {
  const reviewer = map.reviewer;
  const hit = reviewer ? AUTHORS.filter(id => map[id] && sameModel(catalog, map[id]!.model, reviewer.model)) : [];
  if (!reviewer || !hit.length) return null;
  // An alias and the id it resolves to are one model, so neither is an alternative to the other, and they count once.
  const seen = new Set<string>();
  const alternatives = catalog.filter(row => {
    const key = canonicalModel(catalog, row.model);
    if (!row.available || sameModel(catalog, row.model, reviewer.model) || row.rank < rankOf(catalog, reviewer.model) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!alternatives.length) return null;
  return { hit, alternatives, fix: pickFix(alternatives.filter(row => AUTHORS.every(id => !map[id] || !sameModel(catalog, map[id]!.model, row.model))), map, catalog, defaults) };
}
// The same reviewer rule when it only warns: the author seats share the reviewer's model but nothing at least as strong is available to change it to.
export const reviewerSameButAllowed = (map: SeatMap, catalog: SeatModel[]) =>
  !!map.reviewer && !reviewerBlock(map, catalog) && AUTHORS.some(id => !!map[id] && sameModel(catalog, map[id]!.model, map.reviewer!.model));

// The first refusal main would give for this map, or null: 保存 is disabled on it.
export function firstRefusal(map: SeatMap, catalog: SeatModel[]): SeatsSaveError | null {
  const refuse = (code: SeatsSaveError['code'], seat: string, message: string): SeatsSaveError => ({ ok: false, code, seat, message });
  for (const seat of ['lead.claude', 'lead.codex', ...Object.keys(map).filter(id => id !== 'lead')] as SlotId[]) {
    const value = getSlot(map, seat);
    if (!value) continue;
    const family = familyOf(value.model);
    if (slotFamily(seat) && slotFamily(seat) !== family) return refuse('lead-family', seat, `The ${seat} slot requires a ${slotFamily(seat)} model.`);
    const row = rowFor(catalog, value.model);
    if (!(row?.efforts ?? EFFORTS[family]).includes(value.effort)) return refuse('invalid-effort', seat, `Unsupported ${family} effort.`);
    if (value.fast && !row?.fast) return refuse('fast-not-allowed', seat, 'This model has no fast mode.');
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

// The seats that belong to a step of the flow, in the skill's seat order.
export const seatsOfPhase = (phase: Phase, seats: SeatId[]) => seats.filter(id => PHASES[id] === phase);

// 模型盘: the catalog grouped by family and then by model line, the line read from the id (never from a list of names, so a new line shows up by itself). Each line shows its aliases
// and its newest version first; older versions fold away. A search keeps only the matching rows.
export type PaletteLine = { name: string; shown: SeatModel[]; older: SeatModel[] };
export type PaletteGroup = { family: Family; total: number; lines: PaletteLine[] };
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
