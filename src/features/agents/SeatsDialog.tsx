import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCounterClockwise, CheckCircle, ListBullets, Prohibit, Warning, X } from '@phosphor-icons/react';
import type { SeatId, SeatMap, SeatModel, SeatsInfo } from '../../shared/types';
import { t } from '../../shared/i18n';
import {
  PHASES, assignModel, baselineFor, changedCount, changedSeats, fallbackFor, firstRefusal, getSlot, isAvailable, lowerLayer, modelRow, reviewerBlock, reviewerSameButAllowed,
  sameSeat, saveSeats, scopePayload, withSlot, seatOfSlot, setEffort, setFast, slotFamily, slotsOf, startScope, swapSlots, familyOf,
  type Edit, type Phase, type Scope, type SlotId,
} from './skill-seats';
import './seats-dialog.css';

// The model-routing seats, as the C2 floating ring: a disc with a seat tile on its rim for each role, the inner ring (规划 → 构建 → 审查 → 验收) lighting the hovered seat's step, and a tray of models to drag onto the seats.
// A seat's 更换 button opens a keyboard menu (model, effort, fast); 座位清单 lists the same seats plainly and takes over on a narrow dialog. Nothing is saved until 保存, and it applies from the next conversation.
const SEAT_NAMES: Record<SeatId, string> = { lead: '领队', architect: '架构师', core: '核心工程师', execution: '执行工程师', visual: '视觉与验收', lookup: '查找', reviewer: '审查' };
const PHASE_ARCS: [Phase, string, number][] = [['plan', '规划', -135], ['build', '构建', -45], ['review', '审查', 45], ['accept', '验收', 135]];
const NARROW = 640, STAGE = 900, TILT = 55;
const seatName = (id: SeatId) => id in SEAT_NAMES ? t(SEAT_NAMES[id]) : id;
const slotName = (slot: SlotId) => slot === 'lead.claude' ? `${seatName('lead')} · ${t('Claude 槽')}` : slot === 'lead.codex' ? `${seatName('lead')} · ${t('Codex 槽')}` : seatName(slot);
const effortLine = (seat: { effort: string; fast?: boolean }) => `${seat.effort}${seat.fast ? ` · ${t('快速')}` : ''}`;
const layers = (count: number, className?: string) => Array.from({ length: count }, (_, index) => <i key={index} className={className} style={{ transform: `translateZ(${-(index + 1)}px)` }} />);
const UNDER = layers(14, 'seats-under'), PEDESTAL = layers(9);
const point = (angle: number, radius: number) => [Math.round(Math.cos(angle * Math.PI / 180) * radius), Math.round(Math.sin(angle * Math.PI / 180) * radius)];
const arc = (center: number, radius: number) => {
  const at = (degrees: number) => point(degrees, radius).map(value => Math.round((142 + value) * 10) / 10);
  const [x0, y0] = at(center - 33), [x1, y1] = at(center + 33);
  return `M${x0} ${y0}A${radius} ${radius} 0 0 1 ${x1} ${y1}`;
};
const REFUSALS = { 'unknown-model': '没有这个模型', unavailable: '不可用', family: '这个座位只放 {family} 模型', same: '', effort: '这个模型不支持该强度', fast: '只有 GPT 座位能开快速' };

type Notice = { kind: 'info' | 'ok' | 'error'; text: string };
type Menu = { slot: SlotId; left: number; top: number };

export function SeatsDialog({ info, projectId, terminalId, onClose }: { info: SeatsInfo; projectId?: string; terminalId?: string; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>(() => startScope(info, projectId));
  const [draft, setDraft] = useState<SeatMap | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [listMode, setListMode] = useState(false);
  const [width, setWidth] = useState(STAGE);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [landed, setLanded] = useState<SlotId | null>(null);
  const [over, setOver] = useState<SlotId | null>(null);
  const [ghost, setGhost] = useState<{ model: string; x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), menuBox = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const { catalog, seats } = info, lower = lowerLayer(info, scope), baseline = baselineFor(info, scope), working = draft ?? baseline;
  const count = changedCount(seats, working, baseline), dirty = count > 0, block = reviewerBlock(working, catalog), refusal = firstRefusal(working, catalog);
  const narrow = width < NARROW, list = listMode || narrow;
  const slots = seats.flatMap(slotsOf);
  const label = (model: string) => modelRow(catalog, model)?.label ?? model;

  const keepButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => { if (discarding) keepButton.current?.focus({ preventScroll: true }); }, [discarding]);
  // A refreshed record that already holds the draft makes the draft redundant (after a save), so later changes made elsewhere show.
  useEffect(() => { if (draft && !changedCount(seats, draft, baseline)) setDraft(null); }, [info, scope]);
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), 900);
    return () => clearTimeout(timer);
  }, [landed]);
  useEffect(() => {
    const items = menuBox.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)');
    if (menu && items?.length) (Array.from(items).find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]).focus({ preventScroll: true });
  }, [menu?.slot]);

  const refusalText = (result: Extract<Edit, { ok: false }>, slot: SlotId, model: string) => {
    if (result.reason === 'same') return null;
    if (result.reason === 'unavailable') return t('{model}（{reason}）不能放入座位', { model: label(model), reason: modelRow(catalog, model)?.reason ?? t(REFUSALS.unavailable) });
    return t(REFUSALS[result.reason], { family: slotFamily(slot) === 'codex' ? 'Codex' : 'Claude' });
  };
  const apply = (result: Edit, slot: SlotId, success: string, failedFor = slot, model = '') => {
    if (result.ok) { setDraft(result.map); setDiscarding(false); setLanded(slot); setNotice({ kind: 'info', text: success }); return; }
    const text = refusalText(result, failedFor, model);
    if (text) setNotice({ kind: 'error', text });
  };
  const assign = (slot: SlotId, model: string) => apply(assignModel(working, slot, model, catalog), slot,
    t('{seat} 换成 {model}；下一次对话生效', { seat: slotName(slot), model: label(model) }), slot, model);
  const swap = (from: SlotId, slot: SlotId) => {
    const result = swapSlots(working, from, slot, catalog), lead = slotFamily(from) ? from : slot;
    apply(result, slot, t('{first} 与 {second} 互换了模型；下一次对话生效', { first: slotName(from), second: slotName(slot) }), lead);
  };
  const drop = (slot: SlotId, model: string, from: SlotId | null) => { if (from) swap(from, slot); else assign(slot, model); };
  const edit = (result: Edit) => { if (result.ok) { setDraft(result.map); setDiscarding(false); } };
  const changeScope = (next: Scope) => {
    // Only the slots the owner changed (working differs from the old scope's saved view) move to the new scope; its own saved seats stay.
    if (draft) setDraft(slots.reduce((map, slot) => { const seat = getSlot(working, slot); return seat && !sameSeat(seat, getSlot(baseline, slot)) ? withSlot(map, slot, seat) : map; }, baselineFor(info, next)));
    setScope(next);
  };
  // Closing with an unsaved draft asks once, inline.
  const close = () => { if (dirty && !discarding) setDiscarding(true); else onClose(); };

  const slotAt = (x: number, y: number) => (document.elementFromPoint(x, y)?.closest('[data-slot]') as HTMLElement | null)?.dataset.slot as SlotId | undefined;
  // A token lifts after 5px of travel; the seat under the pointer when it is released takes it (a tray model replaces, a seat's model swaps).
  const startDrag = (event: ReactPointerEvent, model: string, from: SlotId | null) => {
    if (event.button || !isAvailable(catalog, model)) return;
    const origin = { x: event.clientX, y: event.clientY, moved: false };
    const move = (next: PointerEvent) => {
      if (!origin.moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 5) return;
      origin.moved = true;
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

  const openMenu = (slot: SlotId, button: HTMLElement) => {
    if (menu?.slot === slot) { closeMenu(); return; }
    const box = button.getBoundingClientRect();
    opener.current = button;
    setMenu({ slot, left: Math.max(8, Math.min(window.innerWidth - 288, Math.round(box.left))), top: Math.max(8, Math.min(window.innerHeight - 320, Math.round(box.bottom + 4))) });
  };
  const closeMenu = () => { setMenu(null); opener.current?.focus({ preventScroll: true }); };
  const pick = (slot: SlotId, model: string) => { assign(slot, model); closeMenu(); };

  const reset = () => { setDraft(lower); setDiscarding(false); setNotice({ kind: 'info', text: t('已恢复默认座位；下一次对话生效') }); setMenu(null); };
  const save = async () => {
    if (!dirty || refusal || saving) return;
    setSaving(true);
    const result = await saveSeats(window.agentrix, scope, projectId ?? null, working, lower);
    setSaving(false);
    setNotice(result.ok ? { kind: 'ok', text: t('已保存，下一次对话生效；这次对话的座位不变') } : { kind: 'error', text: t('没有保存：{message}', { message: result.message }) });
  };
  const fix = () => { if (block?.fix) apply(assignModel(working, 'reviewer', block.fix.model, catalog), 'reviewer', t('审查改用 {model}', { model: block.fix.label })); };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (menu) closeMenu(); else if (discarding) setDiscarding(false); else close(); return; }
    if (event.key === 'Tab') {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, [tabindex="0"]') ?? []).filter(item => !item.closest('[hidden]'));
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

  // What the seat says under its model: its effort, and why it is not what the owner chose.
  const slotState = (slot: SlotId) => {
    const seat = getSlot(working, slot);
    if (!seat) return null;
    if (slot === 'reviewer' && block) return { kind: 'bad', short: t('已阻止 · 同模型'), title: blockMessage() };
    if (slot === 'reviewer' && reviewerSameButAllowed(working, catalog)) return { kind: 'warn', short: t('同模型 · 无更强可换'), title: t('账户里没有不弱于它的其他模型，允许保留') };
    if (isAvailable(catalog, seat.model)) return null;
    const fallback = fallbackFor(info, slot, working), reason = modelRow(catalog, seat.model)?.reason ?? '';
    if (fallback) return { kind: 'warn', short: t('回退 {model}', { model: label(fallback.model) }), title: t('{model}（{reason}）；实际使用 {fallback}', { model: label(seat.model), reason, fallback: label(fallback.model) }) };
    return { kind: 'warn', short: t('暂不使用'), title: `${label(seat.model)}${reason ? `（${reason}）` : ''}` };
  };
  function blockMessage() {
    const model = label(working.reviewer?.model ?? '');
    return t('审查（{model}）与{seats}使用同一模型，账户里还有不弱于它的 {others}，所以不能保存。', {
      model, seats: block?.hit.map(seatName).join('、') ?? '', others: block?.alternatives.map(row => row.label).join('、') ?? '' });
  }
  const stateMark = (state: NonNullable<ReturnType<typeof slotState>>) => <span className={`seats-state is-${state.kind}`} title={state.title}>
    {state.kind === 'bad' ? <Prohibit size={14} aria-hidden="true" /> : <Warning size={14} aria-hidden="true" />}{state.short}</span>;

  const token = (model: string, from: SlotId | null, landing = false) => {
    const row = modelRow(catalog, model), off = !isAvailable(catalog, model);
    return <span className={`seats-gem${off ? ' is-off' : ''}${landing && landed ? ' is-landing' : ''}`} data-family={row?.family ?? familyOf(model)} aria-disabled={off || undefined}
      title={off ? t('{model}（{reason}）不能放入座位', { model: label(model), reason: row?.reason ?? '' }) : t('{model} · 拖到座位上', { model: label(model) })}
      onPointerDown={event => startDrag(event, model, from)}><i className="seats-mk" />{label(model)}{off && <small>{row?.reason}</small>}</span>;
  };
  const changeButton = (slot: SlotId) => <button type="button" className="seats-btn is-small" data-pick={slot} aria-haspopup="menu" aria-expanded={menu?.slot === slot}
    aria-label={t('{seat}：更换模型、强度、快速', { seat: slotName(slot) })} onClick={event => openMenu(slot, event.currentTarget)}>{t('更换')}</button>;

  const tile = (id: SeatId, index: number) => {
    const multi = id === 'lead', [x, y] = id === 'lead' ? [0, -282] : point(-90 + index * 360 / seats.length, 270), w = multi ? 270 : 164, h = multi ? 124 : 108;
    const blocked = id === 'reviewer' && !!block, ripple = landed && slotsOf(id).includes(landed);
    const style = { '--w': `${w}px`, '--x': `${x}px`, '--y': `${y}px`, '--tilt': `${TILT}deg` } as CSSProperties;
    return <div key={id} className={`seats-tile${slotsOf(id).includes(over as SlotId) ? ' is-over' : ''}`} style={style} data-seat={id}
      onMouseEnter={() => setPhase(PHASES[id] ?? null)} onMouseLeave={() => setPhase(null)} onFocus={() => setPhase(PHASES[id] ?? null)} onBlur={() => setPhase(null)}>
      <i className="seats-tsh" /><span className="seats-ped">{PEDESTAL}</span>
      <div className="seats-bb" style={{ '--w': `${w}px`, '--h': `${h}px` } as CSSProperties}>
        <div className={`seats-plate${blocked ? ' is-blocked' : ''}${ripple ? ' is-ripple' : ''}`}>
          <div className="seats-plate-head"><b>{seatName(id)}</b>{info.fresh.includes(id) && <span className="seats-tag">{t('新实例')}</span>}
            {changedSeats(seats, working, baseline).includes(id) && <span className="seats-chg">{t('已改')}</span>}</div>
          <div className="seats-plate-body">{slotsOf(id).map(slot => {
            const seat = getSlot(working, slot), state = slotState(slot);
            return <div key={slot} className={`seats-slot${over === slot ? ' is-over' : ''}`} data-slot={slot}>
              {multi && <span className="seats-slot-label">{slot === 'lead.claude' ? t('Claude 槽') : t('Codex 槽')}</span>}
              <div className="seats-slot-token">{seat ? token(seat.model, slot, landed === slot) : <span className="seats-empty">{t('未设置')}</span>}</div>
              <div className="seats-slot-foot"><span className="seats-slot-info"><span>{seat ? effortLine(seat) : ''}</span>{state && stateMark(state)}</span>{changeButton(slot)}</div>
            </div>;
          })}</div>
        </div>
      </div>
    </div>;
  };

  const scale = Math.max(0.7, Math.min(1, width / STAGE));
  const disc = <div className="seats-scene" style={{ zoom: scale } as CSSProperties}>
    <div className="seats-stage" style={{ '--tilt': `${TILT}deg` } as CSSProperties}><div className="seats-float"><div className="seats-plane">
      <i className="seats-gshadow" /><i className="seats-glow" />{UNDER}<i className="seats-top" /><i className="seats-track" /><i className="seats-hole" />
      <svg className="seats-flow" viewBox="0 0 284 284" aria-hidden="true">{PHASE_ARCS.map(([key, , center]) => <path key={key} className={phase === key ? 'is-lit' : ''} d={arc(center, 118)} />)}</svg>
      {PHASE_ARCS.map(([key, name, center]) => { const [x, y] = point(center, 118);
        return <span key={key} className={`seats-phase${phase === key ? ' is-lit' : ''}`} style={{ '--x': `${x}px`, '--y': `${y}px`, '--tilt': `${TILT}deg` } as CSSProperties}>{t(name)}</span>; })}
      {seats.map(tile)}
    </div></div></div>
    <div className="seats-dock" aria-label={t('模型盘')}><span className="seats-dock-title" title={t('拖到座位上')}>{t('模型盘')}</span>{catalog.map(row => <span key={row.model}>{token(row.model, null)}</span>)}</div>
  </div>;

  const roster = <div className="seats-roster" role="list" aria-label={t('座位清单')}>{slots.map(slot => {
    const seat = getSlot(working, slot), state = slotState(slot), row = seat && modelRow(catalog, seat.model);
    return <div key={slot} className={`seats-row${slot === 'reviewer' && block ? ' is-blocked' : ''}`} role="listitem" data-slot={slot}>
      <b>{slotName(slot)}{info.fresh.includes(seatOfSlot(slot)) && <span className="seats-tag">{t('新实例')}</span>}</b>
      <span className="seats-row-model"><i className="seats-mk" data-family={row?.family ?? (seat && familyOf(seat.model))} />{seat ? label(seat.model) : t('未设置')}{row && !row.available && <small>{row.reason}</small>}</span>
      <span className="seats-row-effort">{seat ? effortLine(seat) : ''}</span>
      <span className="seats-row-state">{state ? stateMark(state) : changedSeats(seats, working, baseline).includes(seatOfSlot(slot)) ? t('已改，待生效') : t('正常')}</span>
      {changeButton(slot)}
    </div>;
  })}</div>;

  const current = info.current;
  const seatTags = current && seats.filter(id => slotsOf(id).some(slot => getSlot(current, slot))).map(id => {
    const shown = slotsOf(id).filter(slot => getSlot(current, slot)), changed = shown.some(slot => !sameSeat(getSlot(current, slot), getSlot(working, slot)));
    const text = (map: SeatMap) => shown.map(slot => { const seat = getSlot(map, slot); return seat ? `${label(seat.model)} ${effortLine(seat)}` : ''; }).join(' + ');
    return <span key={id} className={`seats-now${changed ? ' is-diff' : ''}`}><b>{seatName(id)}</b>{text(current)}{changed && ` → ${text(working)}`}</span>;
  });
  const menuSeat = menu && getSlot(working, menu.slot), menuFamily = menu && slotFamily(menu.slot), menuModel = menuSeat && modelRow(catalog, menuSeat.model);
  const menuRows = menu ? catalog.filter((row: SeatModel) => !menuFamily || row.family === menuFamily) : [];

  return createPortal(<div className="seats-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} className="seats-dialog" role="dialog" aria-modal="true" aria-labelledby="seats-title" tabIndex={-1} onKeyDown={keys}>
      <header className="seats-head">
        <div><h2 id="seats-title">{t('模型路由')}</h2><p>{t('每个座位放哪个模型由你定。把模型拖到座位上，或点座位上的「更换」。')}</p></div>
        <div className="seats-head-actions">
          {!narrow && <button type="button" className="seats-btn" aria-pressed={listMode} onClick={() => setListMode(!listMode)}><ListBullets size={14} aria-hidden="true" />{t('座位清单')}</button>}
          <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={close}><X size={14} aria-hidden="true" /></button>
        </div>
      </header>
      <div ref={body} className="seats-body">
        <section className="seats-strip" aria-label={t('下一次对话生效')}>
          <div className="seats-strip-row">
            <span className="seats-effective"><i className={`seats-dot ${block ? 'is-bad' : dirty ? 'is-on' : 'is-ok'}`} />{t('下一次对话生效')}</span>
            <span>{block ? t('有座位被阻止，不能保存') : dirty ? t('草稿未保存 · 已改 {count} 个座位', { count }) : t('没有改动')}</span>
            <span className="seats-grow" />
            <label className="seats-scope">{t('范围')}<select aria-label={t('设置范围')} value={scope} onChange={event => changeScope(event.target.value as Scope)}>
              <option value="global">{t('全局 · 所有项目')}</option>{projectId && <option value="project">{t('本项目 · 覆盖全局')}</option>}</select></label>
            <button type="button" className="seats-btn" data-reset disabled={!Object.keys(scopePayload(working, lower)).length} onClick={reset}><ArrowCounterClockwise size={14} aria-hidden="true" />{t('恢复默认')}</button>
            <button type="button" className="seats-btn is-primary" data-save disabled={!dirty || !!refusal || saving} title={block ? blockMessage() : undefined} onClick={() => { void save(); }}>{t('保存')}</button>
          </div>
          {block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" />
            <span><b>{t('审查座位被阻止。')}</b>{blockMessage()}{!block.fix && ` ${t('请先改动{seats}的模型。', { seats: block.hit.map(seatName).join('、') })}`}</span>
            <span className="seats-grow" />{block.fix && <button type="button" className="seats-btn" data-fix={block.fix.model} onClick={fix}>{t('审查改用 {model}', { model: block.fix.label })}</button>}</div>}
          {refusal && !block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" /><span>{refusal.message}</span></div>}
          <div className="seats-strip-row"><span>{t('本次对话（只读）')}</span>
            {seatTags ? <div className="seats-nows">{seatTags}</div> : <span>{terminalId ? t('这个终端还没有运行中的对话') : t('没有选定终端')}</span>}</div>
          {discarding && dirty && <div className="seats-banner" role="alertdialog" aria-label={t('放弃未保存的修改？')}><Warning size={14} aria-hidden="true" /><span>{t('有 {count} 个座位的修改还没保存，关闭会丢掉它们。', { count })}</span><span className="seats-grow" />
            <button ref={keepButton} type="button" className="seats-btn" data-keep onClick={() => setDiscarding(false)}>{t('继续编辑')}</button><button type="button" className="seats-btn" data-discard onClick={onClose}>{t('放弃修改')}</button></div>}
          <p className="seats-notice" role="status" aria-live="polite" data-kind={notice?.kind}>{notice?.kind === 'ok' && <CheckCircle size={14} aria-hidden="true" />}{notice?.text}</p>
        </section>
        {list ? roster : disc}
      </div>
      {menu && menuSeat && <div ref={menuBox} className="seats-menu" role="menu" aria-label={t('{seat}：选择模型', { seat: slotName(menu.slot) })} style={{ left: menu.left, top: menu.top }} onKeyDown={menuKeys}>
        <h3>{t('{seat}：选择模型', { seat: slotName(menu.slot) })}</h3>
        {menuRows.map(row => <button key={row.model} type="button" role="menuitemradio" className="seats-menu-item" aria-checked={row.model === menuSeat.model} data-assign={row.model} disabled={!row.available} onClick={() => pick(menu.slot, row.model)}>
          <i className="seats-mk" data-family={row.family} />{row.label}{!row.available ? <small>{row.reason}</small> : row.model === menuSeat.model && <small>{t('当前')}</small>}</button>)}
        <div className="seats-menu-settings">
          <select data-effort={menu.slot} aria-label={t('{seat}的推理强度', { seat: slotName(menu.slot) })} value={menuSeat.effort} onChange={event => edit(setEffort(working, menu.slot, event.target.value))}>
            {(menuModel?.efforts ?? [menuSeat.effort]).map(effort => <option key={effort} value={effort}>{t('强度 {effort}', { effort })}</option>)}</select>
          {familyOf(menuSeat.model) === 'codex' && <button type="button" className="seats-switch" role="switch" aria-checked={!!menuSeat.fast} data-fast={menu.slot} aria-label={t('{seat}快速模式', { seat: slotName(menu.slot) })}
            onClick={() => edit(setFast(working, menu.slot, !menuSeat.fast))}>{t('快速')}<i /></button>}
        </div>
      </div>}
      {ghost && <span className="seats-ghost" style={{ left: ghost.x, top: ghost.y }} data-family={modelRow(catalog, ghost.model)?.family}><i className="seats-mk" />{label(ghost.model)}</span>}
    </div>
  </div>, document.body);
}
