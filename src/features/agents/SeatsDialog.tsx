import { routingRoleName } from '../../shared/routing-command.ts';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCounterClockwise, ArrowsClockwise, BookOpen, CaretDown, CheckCircle, ClipboardText, Code, Flask, GitBranch, Infinity as InfinityIcon, MagnifyingGlass, PencilSimple, Prohibit, ShieldCheck, Stack, User, Warning, X } from '@phosphor-icons/react';
import type { SeatId, SeatIssue, SeatMap, SeatModel, SeatRole, SeatsInfo } from '../../shared/types';
import { t, currentLanguage } from '../../shared/i18n';
import {
  shortLabel, paletteGroups, ageOf, menuPlacement, topAlternatives, withInstalled, assignCustom, assignModel, baselineFor, changedCount,
  changedSeats, fallbackFor, firstRefusal, getSlot, isAvailable, issuesOf, lowerLayer, modelRow, reviewerBlock, rowFor, reviewerSameButAllowed,
  sameSeat, saveSeats, scopePayload, withSlot, setEffort, setFast, startScope, swapSlots, familyOf,
  type Edit, type Scope, type SlotId,
} from './skill-seats';
import './seats-dialog.css';

const ROLE_ICONS = { orchestrator: GitBranch, product: ClipboardText, architect: Stack, designer: PencilSimple, developer: Code,
  reviewer: MagnifyingGlass, qa: Flask, researcher: BookOpen, devops: InfinityIcon, security: ShieldCheck };
const ROLE_NAMES: Record<string, string> = { orchestrator: 'Orchestrator Agent', product: 'Product', architect: 'Architect', designer: 'Designer', developer: 'Developer', reviewer: 'Reviewer', qa: 'QA / Tester', researcher: 'Researcher', devops: 'DevOps', security: 'Security' };
const SPECIALTIES = ['Frontend', 'Backend', 'Desktop', 'Database', 'AI'];
const effortLine = (seat: { effort: string; fast?: boolean }) => [seat.effort, seat.fast && t('快速')].filter(Boolean).join(' · ');
const REFUSALS = {
  'unknown-model': '没有这个模型', unavailable: '不可用', same: '', effort: '这个模型不支持该强度', fast: '这个模型不能开快速',
  'invalid-id': '模型名只能含字母、数字和 . : @ + / [ ] - _，以字母或数字开头，最多 160 个字符',
};
// Why a model has no fast switch, and what a model that has one costs.
const FAST_REASONS = { unsupported: '这个模型不支持快速', unknown: '还不确定这个模型是否支持快速', 'agent-tool': '通过 Agent 工具运行，没有快速模式' };
const FAST_BILLING = '快速模式可能按不同价格计费（例如 Opus 快速）';
// What main did with a saved seat it could not run as saved.
const ISSUES: Record<SeatIssue['code'], string> = {
  'model-unlisted': '已调整：这个模型不在当前列表里，实际使用 {substitute}',
  'effort-unsupported': '已调整：这个模型不支持所存的强度，实际使用 {substitute}',
  'fast-unsupported': '已调整：这个模型不支持快速，实际使用 {substitute}',
};
const issueText = (issue: SeatIssue) => t(ISSUES[issue.code] ?? issue.code, { substitute: issue.substitute });
const ageText = (at: number | null) => {
  const { unit, count } = ageOf(at, Date.now());
  return unit === 'never' ? t('未刷新') : unit === 'now' ? t('刚刚') : t(unit === 'min' ? '{count} 分钟前' : unit === 'hour' ? '{count} 小时前' : '{count} 天前', { count });
};

type Notice = { kind: 'info' | 'ok' | 'error'; text: string };
type Menu = { kind: 'model' | 'effort'; slot: SlotId; left: number; top?: number; bottom?: number; maxHeight: number };
type Custom = { text: string; error: string };
const inside = (node: unknown, target: unknown) => !!node && typeof (node as Node).contains === 'function' && (node as Node).contains(target as Node);

function migrationLine(line: string) {
  const parts = /^(.*?)总指挥沿用原领队 (Claude|Codex) 槽 (\S+?)(?:；原 Codex 槽 (\S+) 未保留)?$/.exec(line);
  if (!parts) return line;
  const [, prefix, family, model, dropped] = parts;
  return prefix + (dropped ? t('总指挥沿用原领队 {family} 槽 {model}；原 Codex 槽 {dropped} 未保留', { family, model, dropped })
    : t('总指挥沿用原领队 {family} 槽 {model}', { family, model }));
}

export function SeatsDialog({ info: given, projectId, terminalId, migration, onMigration, onDismissMigration, onClose }: {
  info: SeatsInfo; projectId?: string; terminalId?: string; migration?: string;
  onMigration: (text: string) => void; onDismissMigration: () => void; onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>(() => startScope(given, projectId));
  const [draft, setDraft] = useState<SeatMap | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [over, setOver] = useState<SlotId | null>(null);
  const [ghost, setGhost] = useState<{ model: string; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshed, setRefreshed] = useState<SeatsInfo | null>(null);
  const [refreshing, setRefreshing] = useState<'dialog' | 'manual' | null>(null);
  const reading = useRef<'dialog' | 'manual' | null>(null), queued = useRef(false), alive = useRef(true);
  const [custom, setCustom] = useState<Custom | null>(null);
  const [query, setQuery] = useState('');
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [nowOpen, setNowOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const nowBox = useRef<HTMLDivElement>(null), nowButton = useRef<HTMLButtonElement>(null), paletteBox = useRef<HTMLElement>(null), paletteButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!nowOpen && !paletteOpen) return;
    const outside = (event: Event) => {
      if (nowOpen && !inside(nowBox.current, event.target) && !inside(nowButton.current, event.target)) setNowOpen(false);
      if (paletteOpen && !inside(paletteBox.current, event.target) && !inside(paletteButton.current, event.target)) setPaletteOpen(false);
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [nowOpen, paletteOpen]);
  const [moved, setMoved] = useState(() => given.defaultsMoved ?? []);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), menuBox = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  // A refresh answers with a newer record until the pane loads the next one.
  const info = refreshed ?? given;
  const { seats } = info, catalog = withInstalled(info.catalog, info.installed, family => t('{agent} 未安装', { agent: family === 'codex' ? 'Codex' : 'Claude' })), lower = lowerLayer(info, scope), baseline = baselineFor(info, scope), working = draft ?? baseline;
  const count = changedCount(seats, working, baseline), dirty = count > 0, block = reviewerBlock(working, catalog, info.defaults), refusal = firstRefusal(working, catalog);
  const roles = info.roles ?? [];
  const lead = roles.find(role => role.id === info.lead), team = seats.filter(id => id !== info.lead).flatMap(id => roles.filter(role => role.id === id));
  const seatName = (id: SeatId) => routingRoleName(roles.find(role => role.id === id)?.name ?? id, t);
  const slotName = seatName;
  const label = (model: string) => modelRow(catalog, model)?.label ?? model;

  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; dialog.current?.focus(); void refresh(true); return () => { alive.current = false; }; }, []);
  useEffect(() => { setRefreshed(null); if (given.defaultsMoved?.length) setMoved(given.defaultsMoved); }, [given]);
  useEffect(() => { if (discarding) keepButton.current?.focus({ preventScroll: true }); }, [discarding]);
  // A refreshed record that already holds the draft makes the draft redundant (after a save), so later changes made elsewhere show.
  useEffect(() => { if (draft && !changedCount(seats, draft, baseline)) setDraft(null); }, [info, scope]);
  useEffect(() => {
    const items = menuBox.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)');
    if (menu && items?.length) (Array.from(items).find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]).focus({ preventScroll: true });
  }, [menu?.slot, menu?.kind]);
  // A click anywhere outside the open menu (and not on the button that opened it, which toggles it) closes it.
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => { if (!inside(menuBox.current, event.target) && !inside(opener.current, event.target)) closeMenu(); };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [menu?.slot, menu?.kind]);

  const refusalText = (result: Extract<Edit, { ok: false }>, model: string) => {
    if (result.reason === 'same') return null;
    if (result.reason === 'unavailable') return t('{model}（{reason}）不能放入座位', { model: label(model), reason: modelRow(catalog, model)?.reason ?? t(REFUSALS.unavailable) });
    return t(REFUSALS[result.reason]);
  };
  // 刷新: main reads the model lists again and answers with the seats; a failed read leaves the dialog as it was. Opening the dialog reads once too, as
  // reason 'dialog' (main probes only a list older than its open throttle) and quietly; the 刷新 button is 'manual' (always probes). A click during the opening read
  // runs right after it. Migration notices are kept by the host even if the dialog closes while the read is in flight.
  const refresh = async (opening = false) => {
    if (reading.current) { if (!opening) queued.current = true; return; }
    if (!window.agentrix?.skillSeatsRefresh) return;
    reading.current = opening ? 'dialog' : 'manual';
    setRefreshing(reading.current);
    try {
      const next = await window.agentrix.skillSeatsRefresh(projectId ?? null, terminalId ?? null, opening ? 'dialog' : 'manual');
      if (next?.migrated) onMigration(next.migrated);
      if (!alive.current) return;
      if (next) {
        setRefreshed(next);
        if (next.defaultsMoved?.length) setMoved(next.defaultsMoved);
        if (!opening) setNotice({ kind: 'ok', text: t('模型列表已刷新') });
      }
      else if (!opening) setNotice({ kind: 'error', text: t('没有刷新：没有可用的座位信息') });
    } catch (error) {
      if (alive.current) setNotice({ kind: 'error', text: t('没有刷新：{message}', { message: error instanceof Error ? error.message : String(error) }) });
    } finally {
      reading.current = null;
      if (alive.current) { setRefreshing(null); if (queued.current) { queued.current = false; void refresh(); } }
    }
  };
  const apply = (result: Edit, success: string, model = '') => {
    if (result.ok) { setDraft(result.map); setDiscarding(false); setNotice({ kind: 'info', text: success }); return; }
    const text = refusalText(result, model);
    if (text) setNotice({ kind: 'error', text });
  };
  const assign = (slot: SlotId, model: string) => apply(assignModel(working, slot, model, catalog),
    t('{seat} 换成 {model}；下一次对话生效', { seat: slotName(slot), model: label(model) }), model);
  const swap = (from: SlotId, slot: SlotId) => {
    const result = swapSlots(working, from, slot, catalog);
    apply(result, t('{first} 与 {second} 互换了模型；下一次对话生效', { first: slotName(from), second: slotName(slot) }));
  };
  const drop = (slot: SlotId, model: string, from: SlotId | null) => { if (from) swap(from, slot); else assign(slot, model); };
  // 其他模型…: a refused id stays in the box with its reason; an accepted one is assigned like a listed model.
  const submitCustom = (slot: SlotId) => {
    const model = (custom?.text ?? '').trim(), result = assignCustom(working, slot, model, catalog);
    if (!result.ok && result.reason !== 'same') { setCustom({ text: model, error: refusalText(result, model) ?? '' }); return; }
    apply(result, t('{seat} 换成 {model}；下一次对话生效', { seat: slotName(slot), model: label(model) }));
    closeMenu();
  };
  const edit = (result: Edit) => { if (result.ok) { setDraft(result.map); setDiscarding(false); } };
  const changeScope = (next: Scope) => {
    // Only the slots the owner changed (working differs from the old scope's saved view) move to the new scope; its own saved seats stay.
    if (draft) setDraft(seats.reduce((map, slot) => { const seat = getSlot(working, slot); return seat && !sameSeat(seat, getSlot(baseline, slot)) ? withSlot(map, slot, seat) : map; }, baselineFor(info, next)));
    setScope(next);
  };
  // Closing with an unsaved draft asks once, inline.
  const close = () => { if (dirty && !discarding) setDiscarding(true); else onClose(); };

  const dragged = useRef(false);
  const slotAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-slot]') as HTMLElement | null)?.dataset.slot as SlotId | undefined;
  // A token lifts after 5px of travel; the seat under the pointer when it is released takes it (a palette model replaces, a seat's model swaps).
  const startDrag = (event: ReactPointerEvent, model: string, from: SlotId | null) => {
    dragged.current = false;
    if (event.button || !isAvailable(catalog, model)) return;
    const origin = { x: event.clientX, y: event.clientY, moved: false };
    const move = (next: PointerEvent) => {
      if (!origin.moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 5) return;
      origin.moved = true; dragged.current = true;
      setGhost({ model, x: next.clientX, y: next.clientY });
      setOver(slotAt(next.clientX, next.clientY) ?? null);
    };
    const end = (next: PointerEvent, cancelled: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel);
      setGhost(null); setOver(null);
      const slot = origin.moved && !cancelled ? slotAt(next.clientX, next.clientY) : undefined;
      if (slot && slot !== from) drop(slot, model, from);
    };
    const up = (next: PointerEvent) => end(next, false), cancel = (next: PointerEvent) => end(next, true);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
  };

  // The same button again closes its menu; another button moves it.
  const openMenu = (slot: SlotId, button: HTMLElement, kind: Menu['kind'] = 'model') => {
    if (menu?.slot === slot && menu.kind === kind) { closeMenu(); return; }
    const box = button.getBoundingClientRect();
    opener.current = button;
    setCustom(null);
    const seat = getSlot(working, slot);
    const rows = kind === 'effort' ? (seat ? rowFor(catalog, seat.model)?.efforts.length ?? 4 : 4) : catalog.length;
    setNowOpen(false);
    setMenu({ kind, slot, ...menuPlacement({ left: box.left, top: box.top, bottom: box.bottom }, { width: window.innerWidth, height: window.innerHeight }, rows) });
  };
  const closeMenu = () => { setMenu(null); setCustom(null); opener.current?.focus({ preventScroll: true }); };
  const pick = (slot: SlotId, model: string) => { assign(slot, model); closeMenu(); };

  const reset = () => { setDraft(lower); setDiscarding(false); setNotice({ kind: 'info', text: t('已恢复默认座位；下一次对话生效') }); setMenu(null); };
  const save = async () => {
    if (!dirty || refusal || saving) return;
    setSaving(true);
    const result = await saveSeats(window.agentrix, scope, projectId ?? null, working, lower);
    if (!alive.current) return;
    if (result.ok) {
      const edited = scopePayload(working, lower);
      setRefreshed({ ...info, ...(scope === 'global' ? { global: edited } : { project: edited }) });
      setDraft(current => current === draft ? null : current);
    }
    setSaving(false);
    setNotice(result.ok ? { kind: 'ok', text: t('已保存，下一次对话生效；这次对话的座位不变') } : { kind: 'error', text: t('没有保存：{message}', { message: result.message }) });
  };
  const fix = () => { if (block?.fix) apply(assignModel(working, 'reviewer', block.fix.model, catalog), t('审查改用 {model}', { model: block.fix.label })); };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (menu) closeMenu(); else if (discarding) setDiscarding(false); else if (nowOpen) setNowOpen(false); else if (paletteOpen) setPaletteOpen(false); else close(); return; }
    if (event.key === 'Tab') {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, [tabindex="0"]') ?? []).filter(item => !item.closest('[hidden]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(menuBox.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? []), index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  };

  // What the seat says under its model: why it is not what the owner chose.
  const slotState = (slot: SlotId) => {
    const seat = getSlot(working, slot);
    if (!seat) return null;
    if (slot === 'reviewer' && block) return { kind: 'bad', short: t('已阻止 · 同模型'), title: blockMessage() };
    if (slot === 'reviewer' && reviewerSameButAllowed(working, catalog)) return { kind: 'warn', short: t('同模型 · 无更强可换'), title: t('账户里没有不弱于它的其他模型，允许保留') };
    const issues = sameSeat(seat, getSlot(baseline, slot)) ? issuesOf(info, slot) : [];
    if (issues.length) return { kind: 'warn', short: t('已调整 · {substitute}', { substitute: issues[0].substitute }), title: issues.map(issueText).join('；') };
    if (isAvailable(catalog, seat.model)) return null;
    const fallback = fallbackFor({ ...info, catalog }, slot, working), reason = modelRow(catalog, seat.model)?.reason ?? '';
    if (fallback) return { kind: 'warn', short: t('回退 {model}', { model: label(fallback.model) }), title: t('{model}（{reason}）；实际使用 {fallback}', { model: label(seat.model), reason, fallback: label(fallback.model) }) };
    return { kind: 'warn', short: t('暂不使用'), title: `${label(seat.model)}${reason ? `（${reason}）` : ''}` };
  };
  function blockMessage() {
    const model = label(working.reviewer?.model ?? '');
    const { shown, total } = topAlternatives(block?.alternatives ?? [], 3, { fix: block?.fix ?? null, map: working, catalog, defaults: info.defaults }), names = shown.map(row => row.label).join('、');
    return t('审查（{model}）与{seats}使用同一模型，账户里还有不弱于它的 {others}，所以不能保存。', {
      model, seats: block?.hit.map(seatName).join('、') ?? '', others: total > shown.length ? t('{names} 等 {count} 个', { names, count: total }) : names });
  }
  const stateMark = (state: NonNullable<ReturnType<typeof slotState>>) => <span className={`seats-state is-${state.kind}`} title={state.title}>
    {state.kind === 'bad' ? <Prohibit size={14} aria-hidden="true" /> : <Warning size={14} aria-hidden="true" />}<span>{state.short}</span></span>;

  const modelButton = (slot: SlotId, model?: string) => <button type="button" className="seats-gem" data-pick={slot} aria-haspopup="menu"
    aria-expanded={menu?.slot === slot && menu.kind === 'model'} title={model ? label(model) : undefined}
    aria-label={t('{seat}：选择模型', { seat: slotName(slot) })}
    onPointerDown={event => { if (model) startDrag(event, model, slot); }}
    onClick={event => { if (!dragged.current || event.detail === 0) openMenu(slot, event.currentTarget); }}>
    {model && <i className="seats-mk" data-family={rowFor(catalog, model)?.family} aria-hidden="true" />}
    <span className="seats-gem-name">{model ? shortLabel(label(model)) : t('未设置')}</span><CaretDown size={14} aria-hidden="true" />
  </button>;
  const effortButton = (slot: SlotId) => {
    const seat = getSlot(working, slot);
    return seat && <button type="button" className="seats-effort" data-tile-effort={slot} aria-haspopup="menu" aria-expanded={menu?.slot === slot && menu.kind === 'effort'}
      aria-label={t('{seat}的强度：{effort}', { seat: slotName(slot), effort: seat.effort })} onClick={event => openMenu(slot, event.currentTarget, 'effort')}>{seat.effort}<CaretDown size={12} aria-hidden="true" /></button>;
  };
  const fastSwitch = (slot: SlotId) => {
    const seat = getSlot(working, slot), row = seat && rowFor(catalog, seat.model);
    if (!seat) return null;
    const off = !row?.fast && !seat.fast;
    return <button type="button" className="seats-fast" role="switch" aria-checked={!!seat.fast} data-tile-fast={slot} disabled={off} aria-label={t('{seat}快速模式', { seat: slotName(slot) })}
      title={off ? t(FAST_REASONS[row?.fastReason ?? 'unsupported']) : row?.family === 'claude' ? t(FAST_BILLING) : undefined}
      onClick={() => edit(setFast(working, slot, !seat.fast, catalog))}>{t('快速')}<i /></button>;
  };

  const changed = changedSeats(seats, working, baseline);
  const card = (role: SeatRole, isLead = false) => {
    const id = role.id, seat = getSlot(working, id), state = slotState(id);
    const Icon = ROLE_ICONS[id as keyof typeof ROLE_ICONS] ?? User;
    return <article key={id} className={['seats-team-card', isLead && 'is-lead', over === id && 'is-over', id === 'reviewer' && block && 'is-blocked'].filter(Boolean).join(' ')}
      data-seat={id} data-slot={id}>
      <div className="seats-team-info">
        <div className="seats-team-name"><span className="seats-role-icon"><Icon size={18} aria-hidden="true" /></span>
          <h3>{routingRoleName(role.name, t)}</h3>{currentLanguage() === 'zh' && ROLE_NAMES[id] && <span lang="en">{ROLE_NAMES[id]}</span>}
          {info.fresh.includes(id) && <span className="seats-tag">{t('新实例')}</span>}
          {changed.includes(id) && <span className="seats-chg">{t('已改')}</span>}</div>
        <p title={t(role.detail)}>{t(role.duty)}{role.detail && role.detail !== role.duty && <> · {t(role.detail)}</>}</p>
        {role.outputs && <p className="seats-team-output">{t('产出：{outputs}', { outputs: t(role.outputs) })}</p>}
        {id === 'developer' && <div className="seats-specialties">{SPECIALTIES.map(name => <span key={name}>{name}</span>)}</div>}
        {state && stateMark(state)}
      </div>
      <div className="seats-team-settings">{modelButton(id, seat?.model)}{effortButton(id)}{fastSwitch(id)}</div>
    </article>;
  };
  const chart = <div className="seats-chart">
    <div className="seats-owner" data-owner>
      <span className="seats-role-icon"><User size={18} aria-hidden="true" /></span>
      <div><h3>Human / Owner</h3><p>{t('目标、预算、重大决策、最终授权')}</p></div>
    </div>
    {lead && <><div className="seats-chart-link" aria-hidden="true" />{card(lead, true)}<div className="seats-chart-bus" aria-hidden="true" /></>}
    <div className="seats-team-grid">{team.map(role => card(role))}</div>
  </div>;

  // 模型盘: grouped by family and model line (Opus, Sonnet… / Sol, Astra…), the newest of each line first, older versions folded.
  const searching = query.trim() !== '';
  const chip = (row: SeatModel, old = false) => {
    const off = !row.available;
    return <span key={row.model} className={`seats-chip${old ? ' is-old' : ''}${off ? ' is-off' : ''}`} data-chip={row.model} data-family={row.family} aria-disabled={off || undefined}
      title={off ? t('{model}（{reason}）不能放入座位', { model: row.label, reason: row.reason ?? '' }) : t('{model} · 拖到座位上', { model: row.label })} onPointerDown={event => startDrag(event, row.model, null)}>
      <i className="seats-mk" data-family={row.family} /><span className="seats-chip-name">{shortLabel(row.label)}</span>{row.listed === false && <small data-unlisted>{t('不在最新列表')}</small>}</span>;
  };
  const palette = <aside ref={paletteBox} className={paletteOpen ? "seats-palette is-open" : "seats-palette"} aria-label={t('模型盘')}>
    <header className="seats-palette-head"><h3>{t('模型盘')}</h3>
      <button type="button" className="seats-btn is-icon seats-palette-close" aria-label={t('关闭')} onClick={() => setPaletteOpen(false)}><X size={16} aria-hidden="true" /></button></header>
    <label className="seats-search"><MagnifyingGlass size={14} aria-hidden="true" /><input type="search" data-palette-search spellCheck={false} aria-label={t('搜索模型')} placeholder={t('搜索模型')} value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="seats-groups">{paletteGroups(catalog, query).map(group => <section key={group.family} className="seats-group" data-group={group.family}>
      <h4><i className="seats-mk" data-family={group.family} />{group.family === 'claude' ? 'Claude' : 'Codex'} · {group.total}</h4>
      {group.lines.map(line => { const key = group.family + line.name, open = searching || folds[key];
        return <div key={key} className="seats-line" data-line={line.name || 'other'}><span className="seats-line-name">{line.name || t('其他')}</span>
          {line.shown.map(row => chip(row))}
          {line.older.length > 0 && !searching && <button type="button" className="seats-fold" data-fold={key} aria-expanded={!!open} onClick={() => setFolds({ ...folds, [key]: !open })}>{t('更早版本 ({count})', { count: line.older.length })}</button>}
          {open && line.older.map(row => chip(row, true))}</div>; })}
    </section>)}{searching && !paletteGroups(catalog, query).length && <p className="seats-none">{t('没有匹配的模型')}</p>}</div>
  </aside>;

  const current = info.current;
  const seatTags = current && seats.filter(id => current[id]).map(id => {
    const seat = current[id], next = working[id];
    const text = (value: typeof seat) => value ? [label(value.model), effortLine(value)].join(' · ') : '—';
    return <span key={id} className={sameSeat(seat, next) ? 'seats-now' : 'seats-now is-diff'}><b>{seatName(id)}</b>{text(seat)}
      {!sameSeat(seat, next) && <> → {text(next)}</>}</span>;
  });
  const menuSeat = menu && getSlot(working, menu.slot), menuModel = menuSeat && rowFor(catalog, menuSeat.model);
  const fastNote = menuModel && (!menuModel.fast ? t(FAST_REASONS[menuModel.fastReason ?? 'unsupported']) : menuModel.family === 'claude' ? t(FAST_BILLING) : null);

  return createPortal(<div className="seats-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !menu && !nowOpen && !paletteOpen) close(); }}>
    <div ref={dialog} className="seats-dialog" role="dialog" aria-modal="true" aria-labelledby="seats-title" tabIndex={-1} onKeyDown={keys}>
      <header className="seats-head">
        <div><h2 id="seats-title">{t('模型路由')}</h2></div>
        <span className="seats-age" data-catalog-at>{`${t('模型列表更新于')} Claude ${ageText(info.catalogAt?.claude ?? null)} · Codex ${ageText(info.catalogAt?.codex ?? null)}`}</span>
        <span className="seats-grow" />
        <div className="seats-head-actions">
          <button type="button" className="seats-btn" data-refresh disabled={refreshing === 'manual'} aria-label={t('刷新模型列表')} onClick={() => { void refresh(); }}><ArrowsClockwise size={14} aria-hidden="true" />{t('刷新')}</button>
          <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={close}><X size={14} aria-hidden="true" /></button>
        </div>
      </header>
      <div className="seats-body">
        <section className="seats-strip" aria-label={t('下一次对话生效')}>
          <div className="seats-strip-row">
            <span className="seats-effective"><i className={`seats-dot ${block ? 'is-bad' : dirty ? 'is-on' : 'is-ok'}`} />{t('下一次对话生效')}</span>
            <span>{block ? t('有座位被阻止，不能保存') : dirty ? t('草稿未保存 · 已改 {count} 个座位', { count }) : t('没有改动')}</span>
            <span className="seats-grow" />
            <button type="button" ref={nowButton} className="seats-btn is-small" data-now aria-expanded={nowOpen} onClick={() => setNowOpen(!nowOpen)}>{t('本次对话')}<CaretDown size={12} aria-hidden="true" /></button>
            <button type="button" ref={paletteButton} className="seats-btn is-small" data-palette-toggle aria-pressed={paletteOpen} onClick={() => setPaletteOpen(!paletteOpen)}>{t('模型盘')}</button>
            <label className="seats-scope">{t('范围')}<select aria-label={t('设置范围')} value={scope} onChange={event => changeScope(event.target.value as Scope)}>
              <option value="global">{t('全局 · 所有项目')}</option>{projectId && <option value="project">{t('本项目 · 覆盖全局')}</option>}</select></label>
            <button type="button" className="seats-btn" data-reset disabled={!Object.keys(scopePayload(working, lower)).length} onClick={reset}><ArrowCounterClockwise size={14} aria-hidden="true" />{t('恢复默认')}</button>
            <button type="button" className="seats-btn is-primary" data-save disabled={!dirty || !!refusal || saving} title={block ? blockMessage() : undefined} onClick={() => { void save(); }}>{t('保存')}</button>
          </div>
          {nowOpen && <div ref={nowBox} className="seats-nowbox" role="region" aria-label={t('本次对话（只读）')}>
            <div className="seats-menu-head"><b>{t('本次对话（只读）')}</b><button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={() => { setNowOpen(false); nowButton.current?.focus(); }}><X size={16} aria-hidden="true" /></button></div>
            {seatTags ? <div className="seats-nows">{seatTags}</div> : <span>{terminalId ? t('这个终端还没有运行中的对话') : t('没有选定终端')}</span>}</div>}
          {moved.length > 0 && <div className="seats-banner" role="status" data-moved><CheckCircle size={14} aria-hidden="true" />
            <span>{t('默认已更新为 {changes}', { changes: moved.map(item => `${seatName(item.seat)}：${label(item.from)} → ${label(item.to)}`).join('；') })}</span></div>}
          {migration && <div className="seats-banner" role="status" data-migrated>
            <div>{migration.split('\n').map(line => <p key={line}>{migrationLine(line)}</p>)}</div>
            <button type="button" className="seats-btn" onClick={onDismissMigration}>{t('知道了')}</button>
          </div>}
          {block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" />
            <span><b>{t('审查座位被阻止。')}</b>{blockMessage()}{!block.fix && ` ${t('请先改动{seats}的模型。', { seats: block.hit.map(seatName).join('、') })}`}</span>
            {block.fix && <button type="button" className="seats-btn" data-fix={block.fix.model} onClick={fix}>{t('审查改用 {model}', { model: block.fix.label })}</button>}</div>}
          {refusal && !block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" /><span>{refusal.message}</span></div>}
          {discarding && dirty && <div className="seats-banner is-warn" role="alertdialog" aria-label={t('放弃未保存的修改？')}><Warning size={14} aria-hidden="true" /><span>{t('有 {count} 个座位的修改还没保存，关闭会丢掉它们。', { count })}</span>
            <button ref={keepButton} type="button" className="seats-btn" data-keep onClick={() => setDiscarding(false)}>{t('继续编辑')}</button><button type="button" className="seats-btn" data-discard onClick={onClose}>{t('放弃修改')}</button></div>}
          <p className="seats-notice" role="status" aria-live="polite" data-kind={notice?.kind}>{notice?.kind === 'ok' && <CheckCircle size={14} aria-hidden="true" />}{notice?.text}</p>
        </section>
        <div className="seats-work">{chart}{palette}</div>
      </div>
      {menu && menu.kind === 'model' && <div ref={menuBox} className="seats-menu" role="menu" aria-label={t('{seat}：选择模型', { seat: slotName(menu.slot) })} style={{ left: menu.left, top: menu.top, bottom: menu.bottom, maxHeight: menu.maxHeight }} onKeyDown={menuKeys}>
        <div className="seats-menu-head"><h3>{t('{seat}：选择模型', { seat: slotName(menu.slot) })}</h3><button type="button" className="seats-btn is-icon is-small" data-menu-close aria-label={t('关闭')} onClick={closeMenu}><X size={14} aria-hidden="true" /></button></div>
        <div className="seats-menu-list">
        {catalog.map(row => <button key={row.model} type="button" role="menuitemradio" className="seats-menu-item" aria-checked={row.model === menuSeat?.model} data-assign={row.model} disabled={!row.available} onClick={() => pick(menu.slot, row.model)}>
          <i className="seats-mk" data-family={row.family} />{row.label}{!row.available ? <small>{row.reason}</small> : row.listed === false ? <small data-unlisted>{t('不在最新列表')}</small> : row.model === menuSeat?.model && <small>{t('当前')}</small>}</button>)}
        {custom ? <div className="seats-menu-custom">
          <input type="text" data-custom-input maxLength={160} autoFocus spellCheck={false} aria-label={t('模型名')} placeholder={t('模型名，例如 gpt-6.3-sol')} value={custom.text}
            onChange={event => setCustom({ text: event.target.value, error: '' })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitCustom(menu.slot); } }} />
          <button type="button" className="seats-btn is-small" data-custom-apply onClick={() => submitCustom(menu.slot)}>{t('使用')}</button>
          {custom.error && <small className="seats-menu-error" role="alert" data-custom-error>{custom.error}</small>}
        </div> : <button type="button" role="menuitem" className="seats-menu-item" data-custom onClick={() => setCustom({ text: '', error: '' })}>{t('其他模型…')}</button>}
        </div>
        {menuSeat && <div className="seats-menu-settings">
          <select data-effort={menu.slot} aria-label={t('{seat}的推理强度', { seat: slotName(menu.slot) })} value={menuSeat.effort} onChange={event => edit(setEffort(working, menu.slot, event.target.value, catalog))}>
            {(menuModel?.efforts ?? [menuSeat.effort]).map(effort => <option key={effort} value={effort}>{t('强度 {effort}', { effort })}</option>)}</select>
          <button type="button" className="seats-switch" role="switch" aria-checked={!!menuSeat.fast} data-fast={menu.slot} disabled={!menuModel?.fast && !menuSeat.fast} aria-label={t('{seat}快速模式', { seat: slotName(menu.slot) })}
            onClick={() => edit(setFast(working, menu.slot, !menuSeat.fast, catalog))}>{t('快速')}<i /></button>
          {fastNote && <small className="seats-menu-note" data-fast-note>{fastNote}</small>}
        </div>}
      </div>}
      {menu && menuSeat && menu.kind === 'effort' && <div ref={menuBox} className="seats-menu is-effort" role="menu" aria-label={t('{seat}：选择强度', { seat: slotName(menu.slot) })} style={{ left: menu.left, top: menu.top, bottom: menu.bottom, maxHeight: menu.maxHeight }} onKeyDown={menuKeys}>
        <div className="seats-menu-head"><h3>{t('{seat}：选择强度', { seat: slotName(menu.slot) })}</h3><button type="button" className="seats-btn is-icon is-small" data-menu-close aria-label={t('关闭')} onClick={closeMenu}><X size={14} aria-hidden="true" /></button></div>
        <div className="seats-menu-list">{(menuModel?.efforts ?? [menuSeat.effort]).map(effort => <button key={effort} type="button" role="menuitemradio" className="seats-menu-item" aria-checked={effort === menuSeat.effort} data-pop-effort={effort}
          onClick={() => { edit(setEffort(working, menu.slot, effort, catalog)); closeMenu(); }}>{effort}{effort === menuSeat.effort && <small>{t('当前')}</small>}</button>)}</div>
        <div className="seats-menu-settings">
          <button type="button" className="seats-switch" role="switch" aria-checked={!!menuSeat.fast} data-pop-fast={menu.slot} disabled={!menuModel?.fast && !menuSeat.fast} aria-label={t('{seat}快速模式', { seat: slotName(menu.slot) })}
            onClick={() => edit(setFast(working, menu.slot, !menuSeat.fast, catalog))}>{t('快速')}<i /></button>
          <small className="seats-menu-note" data-fast-note>{fastNote ?? t('开启后更快，用量与计费可能不同')}</small>
        </div>
      </div>}
      {ghost && <span className="seats-ghost" style={{ left: ghost.x, top: ghost.y }} data-family={modelRow(catalog, ghost.model)?.family}><i className="seats-mk" data-family={modelRow(catalog, ghost.model)?.family ?? familyOf(ghost.model)} />{label(ghost.model)}</span>}
    </div>
  </div>, document.body);
}
