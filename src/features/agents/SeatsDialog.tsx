import { routingRoleName } from '../../shared/routing-command.ts';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowCounterClockwise, ArrowsClockwise, BookOpen, CaretDown, CheckCircle, ClipboardText, Code, Flask, GitBranch, Infinity as InfinityIcon, MagnifyingGlass, PencilSimple, Prohibit, ShieldCheck, Stack, User, Warning, X } from '@phosphor-icons/react';
import type { OperationMap, OperationRow, OperationValue, SeatId, SeatIssue, SeatMap, SeatModel, SeatRole, SeatsInfo } from '../../shared/types';
import { t, currentLanguage } from '../../shared/i18n';
import {
  shortLabel, paletteGroups, ageOf, menuPlacement, topAlternatives, withInstalled, assignCustom, assignModel, baselineFor, changedCount,
  changedSeats, fallbackFor, firstRefusal, getSlot, isAvailable, issuesOf, lowerLayer, modelRow, reviewerBlock, rowFor, reviewerSameButAllowed,
  sameSeat, saveSeats, scopePayload, withSlot, setEffort, setFast, startScope, swapSlots, familyOf,
  operationAssignment, operationDiff, operationFamilyReason, operationLayers, operationReviewerBlock,
  type Edit, type Scope, type SlotId,
} from './skill-seats';
import { CurrentOperations, OperationRows, editableOperation, operationLabel, operationName, operationWords } from './OperationRows';
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
type Menu = { kind: 'model' | 'effort' | 'claude' | 'codex'; slot: SlotId } & ReturnType<typeof menuPlacement>;
type Custom = { text: string; error: string };
const operationSlot = (id: string) => `operation:${id}`;
const inside = (node: unknown, target: unknown) => !!node && typeof (node as Node).contains === 'function' && (node as Node).contains(target as Node);

function modelMenuItems(catalog: SeatModel[], selected: string | undefined, pick: (model: string) => void, operation?: OperationRow) {
  return catalog.map(row => {
    const familyReason = operation && operationFamilyReason(operation, row.family);
    return <button key={row.model} type="button" role="menuitemradio" className="seats-menu-item" aria-checked={row.model === selected}
      data-assign={row.model} title={row.label} disabled={!row.available || !!familyReason} onClick={() => pick(row.model)}>
      <i className="seats-mk" data-family={row.family} />
      <span className="seats-menu-model">{row.label}</span>
      <span className="seats-menu-details">
        {!row.available && <small>{row.reason}</small>}
        {familyReason && <small data-family-reason>{t(familyReason)}</small>}
        {row.listed === false && <small data-unlisted>{t('不在最新列表')}</small>}
        {row.available && !familyReason && row.listed !== false && row.model === selected && <small>{t('当前')}</small>}
      </span>
    </button>;
  });
}

type Tab = 'team' | 'operations';

function RoutingTabs({ tab, choose }: { tab: Tab; choose: (tab: Tab) => void }) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'team' : event.key === 'End' ? 'operations' : tab === 'team' ? 'operations' : 'team';
    choose(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-routing-tab="${next}"]`)?.focus();
  };
  return <div className="seats-tabs" role="tablist" aria-label={t('模型路由')} onKeyDown={onKeyDown}>
    {(['team', 'operations'] as const).map(id => <button key={id} type="button" className="seats-btn"
      id={`seats-${id}-tab`} data-routing-tab={id} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
      aria-controls={`seats-${id}-panel`} onClick={() => choose(id)}>{t(id === 'team' ? '团队' : '操作模型')}</button>)}
  </div>;
}

function MenuHeader({ title, close }: { title: string; close: () => void }) {
  return <div className="seats-menu-head"><h3>{title}</h3>
    <button type="button" className="seats-btn is-icon is-small" data-menu-close aria-label={t('关闭')} onClick={close}><X size={14} aria-hidden="true" /></button>
  </div>;
}

function migrationLine(line: string) {
  const parts = /^(.*?)总指挥沿用原领队 (Claude|Codex) 槽 (\S+?)(?:；原 Codex 槽 (\S+) 未保留)?$/.exec(line);
  if (!parts) return line;
  const [, prefix, family, model, dropped] = parts;
  return prefix + (dropped ? t('总指挥沿用原领队 {family} 槽 {model}；原 Codex 槽 {dropped} 未保留', { family, model, dropped })
    : t('总指挥沿用原领队 {family} 槽 {model}', { family, model }));
}

type SeatsDialogProps = {
  info: SeatsInfo; projectId?: string; terminalId?: string; migration?: string;
  onMigration: (text: string) => void; onDismissMigration: () => void; onClose: () => void;
};

function useCatalog({ info: given, projectId, terminalId, onMigration }: SeatsDialogProps) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshed, setRefreshed] = useState<SeatsInfo | null>(null);
  const [refreshing, setRefreshing] = useState<'dialog' | 'manual' | null>(null);
  const reading = useRef<'dialog' | 'manual' | null>(null), queued = useRef(false), alive = useRef(true);
  const [moved, setMoved] = useState(() => given.defaultsMoved ?? []);
  const readVersion = useRef(0);
  const rememberMoved = (next: SeatsInfo | null) => {
    if (alive.current && next?.defaultsMoved?.length) setMoved(next.defaultsMoved);
  };
  const loadInfo = async () => {
    if (!window.agentrix?.skillSeats) return;
    const version = ++readVersion.current;
    const next = await window.agentrix.skillSeats(projectId ?? null, terminalId).catch(() => null);
    rememberMoved(next);
    if (!next || !alive.current || version !== readVersion.current) return;
    if (next.migrated) onMigration(next.migrated);
    setRefreshed(next);
  };
  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const off = window.agentrix?.onSkills?.(() => { void loadInfo(); });
    return () => { alive.current = false; readVersion.current++; off?.(); };
  }, []);
  useEffect(() => { setRefreshed(null); rememberMoved(given); }, [given]);

  const info = refreshed ?? given;
  const { seats, operations } = info;
  const catalog = withInstalled(info.catalog, info.installed, family => t('{agent} 未安装', { agent: family === 'codex' ? 'Codex' : 'Claude' }));
  const roles = info.roles ?? [];
  const seatName = (id: SeatId) => routingRoleName(roles.find(role => role.id === id)?.name ?? id, t);
  const opRows = operations?.rows.filter(editableOperation) ?? [];
  const opAt = (slot: SlotId) => opRows.find(row => operationSlot(row.id) === slot);
  const slotName = (slot: SlotId) => { const row = opAt(slot); return row ? operationName(row) : seatName(slot); };
  const label = (model: string) => shortLabel(modelRow(catalog, model)?.label ?? model);

  const refresh = async (opening = false) => {
    if (reading.current) { if (!opening) queued.current = true; return; }
    if (!window.agentrix?.skillSeatsRefresh) return;
    reading.current = opening ? 'dialog' : 'manual';
    setRefreshing(reading.current);
    const version = ++readVersion.current;
    try {
      const next = await window.agentrix.skillSeatsRefresh(projectId ?? null, terminalId ?? null, opening ? 'dialog' : 'manual');
      if (next?.migrated) onMigration(next.migrated);
      // Main reports moves once. Keep the receipt even if another read wins the data refresh.
      rememberMoved(next);
      if (!alive.current || version !== readVersion.current) return;
      if (next) {
        setRefreshed(next);
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
  return { info, catalog, seats, operations, roles, seatName, opAt, opRows, slotName, label, notice, setNotice, setRefreshed, refreshing, refresh, moved, alive, loadInfo };
}

function useDraft(source: ReturnType<typeof useCatalog>, projectId?: string) {
  const { info, catalog, seats, operations, opRows, alive, setRefreshed, setNotice, loadInfo } = source;
  const [scope, setScope] = useState<Scope>(() => startScope(info, projectId));
  const [draft, setDraft] = useState<SeatMap | null>(null);
  const [operationsDraft, setOperationsDraft] = useState<OperationMap | null>(null);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const lower = lowerLayer(info, scope), baseline = baselineFor(info, scope), working = draft ?? baseline;
  const ops = operationLayers(operations, scope), opValues = operationsDraft ?? ops.baseline;
  const opChanges = operationDiff(opValues, ops.baseline), opPayload = operationDiff(opValues, ops.lower);
  const count = changedCount(seats, working, baseline) + Object.keys(opChanges).length;
  const dirty = count > 0, block = reviewerBlock(working, catalog, info.defaults), refusal = firstRefusal(working, catalog);
  const reviewBlock = operationReviewerBlock(opValues.review, working, catalog, info.defaults);
  const discardShown = discarding && dirty;
  // A refreshed record that already holds the draft makes the draft redundant (after a save), so later changes made elsewhere show.
  useEffect(() => {
    if (draft && !changedCount(seats, draft, baseline)) setDraft(null);
    if (operationsDraft && !Object.keys(opChanges).length) setOperationsDraft(null);
  }, [info, scope]);
  const changeScope = (next: Scope) => {
    // Only the slots the owner changed (working differs from the old scope's saved view) move to the new scope; its own saved seats stay.
    if (draft) setDraft(seats.reduce((map, slot) => {
      const seat = getSlot(working, slot);
      return seat && !sameSeat(seat, getSlot(baseline, slot)) ? withSlot(map, slot, seat) : map;
    }, baselineFor(info, next)));
    if (operationsDraft) setOperationsDraft({ ...operationLayers(operations, next).baseline, ...opChanges });
    setScope(next);
  };
  const reset = () => {
    setDraft(lower);
    setOperationsDraft(ops.lower);
    setDiscarding(false);
    setNotice({ kind: 'info', text: t(operations ? '已恢复默认设置；下一次对话生效' : '已恢复默认座位；下一次对话生效') });
  };
  const save = async () => {
    if (!dirty || refusal || reviewBlock || saving) return;
    setSaving(true);
    const result = await saveSeats(window.agentrix, scope, projectId ?? null, working, lower, opPayload);
    if (!alive.current) return;
    if (result.ok) {
      const edited = scopePayload(working, lower);
      const savedOperations = operations && { ...operations, [scope]: opPayload };
      setRefreshed({ ...info, [scope]: edited, operations: savedOperations });
      setDraft(current => current === draft ? null : current);
      setOperationsDraft(current => current === operationsDraft ? null : current);
      void loadInfo();
    }
    setSaving(false);
    const saved = operations ? '已保存，下一次对话生效' : '已保存，下一次对话生效；这次对话的座位不变';
    const operation = !result.ok && result.error && opRows.find(row => row.id === result.error?.operation);
    const message = !result.ok && operation ? t('{seat}：{reason}', { seat: operationName(operation), reason: operationWords(result.message) }) : !result.ok && result.message;
    setNotice(result.ok ? { kind: 'ok', text: t(saved) } : { kind: 'error', text: t('没有保存：{message}', { message: message || result.message }) });
  };
  const canReset = !!(Object.keys(scopePayload(working, lower)).length || Object.keys(opPayload).length);
  return {
    baseline, working, ops, opValues, count, dirty, block, reviewBlock, refusal, scope, saving, canReset,
    discardShown, setDiscarding, setDraft, setOperationsDraft, changeScope, reset, save,
  };
}

function usePanels({ dirty, discardShown, setDiscarding }: ReturnType<typeof useDraft>, onClose: () => void) {
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
  const dialog = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const beforeDiscard = useRef<HTMLElement | null | undefined>(undefined);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    if (discardShown) { keepButton.current?.focus({ preventScroll: true }); return; }
    const previous = beforeDiscard.current, panel = dialog.current;
    beforeDiscard.current = undefined;
    if (previous === undefined || !panel) return;
    if (previous && panel.contains(previous)) {
      previous.focus({ preventScroll: true });
      if (document.activeElement === previous) return;
    }
    (panel.querySelector<HTMLElement>('button:not(:disabled)') ?? panel).focus({ preventScroll: true });
  }, [discardShown]);
  // Closing with an unsaved draft asks once, inline.
  const close = () => {
    if (!dirty || discardShown) { onClose(); return; }
    const panel = dialog.current, active = document.activeElement;
    beforeDiscard.current = panel && active !== panel && panel.contains(active) ? active as HTMLElement : null;
    setDiscarding(true);
  };
  return { nowOpen, setNowOpen, paletteOpen, setPaletteOpen, nowBox, nowButton, paletteBox, paletteButton, query, setQuery, folds, setFolds, dialog, keepButton, close };
}

function useMenu(source: ReturnType<typeof useCatalog>, draft: ReturnType<typeof useDraft>, { setNowOpen }: ReturnType<typeof usePanels>) {
  const { catalog, opAt } = source, { working, opValues } = draft;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [custom, setCustom] = useState<Custom | null>(null);
  const menuBox = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const items = menuBox.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)');
    if (menu && items?.length) (Array.from(items).find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]).focus({ preventScroll: true });
    else if (menu) menuBox.current?.querySelector<HTMLElement>('[data-menu-close]')?.focus({ preventScroll: true });
  }, [menu?.slot, menu?.kind]);
  // A click anywhere outside the open menu (and not on the button that opened it, which toggles it) closes it.
  useEffect(() => {
    if (!menu) return;
    const outside = (event: Event) => { if (!inside(menuBox.current, event.target) && !inside(opener.current, event.target)) closeMenu(); };
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu?.slot, menu?.kind]);
  // The same button again closes its menu; another button moves it.
  const openMenu = (slot: SlotId, button: HTMLElement, kind: Menu['kind'] = 'model') => {
    if (menu?.slot === slot && menu.kind === kind) { closeMenu(); return; }
    const box = button.getBoundingClientRect();
    opener.current = button;
    setCustom(null);
    const operation = opAt(slot), value = operation ? opValues[operation.id] : getSlot(working, slot);
    const rows = kind === 'model' ? catalog.length + Number(!!operation?.follow) : kind === 'effort' && value && value !== 'follow'
      ? rowFor(catalog, value.model)?.efforts.length ?? 4 : 1;
    setNowOpen(false);
    setMenu({ kind, slot, ...menuPlacement({ left: box.left, top: box.top, bottom: box.bottom }, { width: window.innerWidth, height: window.innerHeight }, rows) });
  };
  const closeMenu = () => { setMenu(null); setCustom(null); opener.current?.focus({ preventScroll: true }); };
  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(menuBox.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? []), index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  };
  return { menu, setMenu, custom, setCustom, menuBox, openMenu, closeMenu, menuKeys };
}

function choiceActions(source: ReturnType<typeof useCatalog>, draft: ReturnType<typeof useDraft>, popup: ReturnType<typeof useMenu>) {
  const { opAt, label, seatName, slotName, catalog, setNotice } = source;
  const { working, opValues, setDraft, setOperationsDraft, setDiscarding, block, reviewBlock } = draft;
  const { custom, setCustom, closeMenu } = popup;
  const refusalText = (result: Extract<Edit, { ok: false }>, model: string) => {
    if (result.reason === 'same') return null;
    if (result.reason === 'unavailable') return t('{model}（{reason}）不能放入座位', { model: label(model), reason: modelRow(catalog, model)?.reason ?? t(REFUSALS.unavailable) });
    return t(REFUSALS[result.reason]);
  };
  const apply = (result: Edit, success: string, model = '') => {
    if (result.ok) { setDraft(result.map); setDiscarding(false); setNotice({ kind: 'info', text: success }); return; }
    const text = refusalText(result, model);
    if (text) setNotice({ kind: 'error', text });
  };
  const updateOperation = (row: ReturnType<typeof opAt>, value: OperationValue) => {
    if (!row) return;
    setOperationsDraft({ ...opValues, [row.id]: value });
    setDiscarding(false);
    setNotice({ kind: 'info', text: t('{seat} 换成 {model}；下一次对话生效', { seat: operationName(row), model: operationLabel(row, value, label) }) });
  };
  const assign = (slot: SlotId, model: string) => {
    const row = opAt(slot);
    if (!row) {
      apply(assignModel(working, slot, model, catalog), t('{seat} 换成 {model}；下一次对话生效', { seat: seatName(slot), model: label(model) }), model);
      return;
    }
    const choice = operationAssignment(row, model, catalog, opValues[row.id]);
    if (choice.value) updateOperation(row, choice.value);
    else setNotice({ kind: 'error', text: t(choice.reason) });
  };
  const swap = (from: SlotId, slot: SlotId) => {
    const result = swapSlots(working, from, slot, catalog);
    apply(result, t('{first} 与 {second} 互换了模型；下一次对话生效', { first: slotName(from), second: slotName(slot) }));
  };
  const drop = (slot: SlotId, model: string, from: SlotId | null) => { if (from && !opAt(slot)) swap(from, slot); else assign(slot, model); };
  // 其他模型…: a refused id stays in the box with its reason; an accepted one is assigned like a listed model.
  const submitCustom = (slot: SlotId) => {
    const model = (custom?.text ?? '').trim(), row = opAt(slot);
    if (row) {
      const choice = operationAssignment(row, model, catalog, opValues[row.id]);
      if (!choice.value) { setCustom({ text: model, error: t(choice.reason) }); return; }
      updateOperation(row, choice.value);
      closeMenu();
      return;
    }
    const result = assignCustom(working, slot, model, catalog);
    if (!result.ok && result.reason !== 'same') { setCustom({ text: model, error: refusalText(result, model) ?? '' }); return; }
    apply(result, t('{seat} 换成 {model}；下一次对话生效', { seat: slotName(slot), model: label(model) }));
    closeMenu();
  };
  const edit = (result: Edit) => { if (result.ok) { setDraft(result.map); setDiscarding(false); } };
  const fix = () => { if (block?.fix) apply(assignModel(working, 'reviewer', block.fix.model, catalog), t('审查改用 {model}', { model: label(block.fix.model) })); };
  const fixOperationReview = () => {
    const slot = operationSlot('review');
    if (reviewBlock?.fix) assign(slot, reviewBlock.fix.model);
    else {
      if (block?.fix) fix();
      updateOperation(opAt(slot), 'follow');
    }
  };
  return { assign, drop, updateOperation, submitCustom, edit, fix, fixOperationReview };
}

function useModelDrag(catalog: SeatModel[], drop: ReturnType<typeof choiceActions>['drop']) {
  const [over, setOver] = useState<SlotId | null>(null);
  const [ghost, setGhost] = useState<{ model: string; x: number; y: number } | null>(null);
  const clear = useRef<(() => void) | null>(null);
  useEffect(() => () => clear.current?.(), []);
  const dragged = useRef(false);
  const slotAt = (x: number, y: number) => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot], [data-op-slot]')?.dataset;
    return target?.opSlot ? operationSlot(target.opSlot) : target?.slot;
  };
  // A token lifts after 5px of travel; the seat under the pointer when it is released takes it (a palette model replaces, a seat's model swaps).
  const startDrag = (event: ReactPointerEvent, model: string, from: SlotId | null) => {
    clear.current?.();
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
      clear.current?.();
      setGhost(null); setOver(null);
      const slot = origin.moved && !cancelled ? slotAt(next.clientX, next.clientY) : undefined;
      if (slot && slot !== from) drop(slot, model, from);
    };
    const up = (next: PointerEvent) => end(next, false), cancel = (next: PointerEvent) => end(next, true);
    clear.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      clear.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  return { over, ghost, startDrag, dragged };
}

function useDialogState(props: SeatsDialogProps) {
  const source = useCatalog(props), draft = useDraft(source, props.projectId);
  const panels = usePanels(draft, props.onClose), popup = useMenu(source, draft, panels);
  const edits = choiceActions(source, draft, popup), drag = useModelDrag(source.catalog, edits.drop);
  const [tab, setTab] = useState<Tab>('team');
  const switchTab = (next: Tab) => { popup.setMenu(null); setTab(next); };
  const { dialog, nowOpen, nowButton, paletteOpen, paletteButton, setNowOpen, setPaletteOpen, close } = panels;
  const { menu, closeMenu } = popup;
  const { discardShown, setDiscarding } = draft;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (menu) closeMenu();
      else if (discardShown) setDiscarding(false);
      else if (nowOpen) { setNowOpen(false); nowButton.current?.focus(); }
      else if (paletteOpen) { setPaletteOpen(false); paletteButton.current?.focus(); }
      else close();
      return;
    }
    if (event.key === 'Tab') {
      const controls = 'button:not(:disabled):not([tabindex="-1"]), select:not(:disabled), input, [tabindex="0"]';
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(controls) ?? []).filter(item => item.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  return { props, source, draft, panels, popup, edits, drag, tab, switchTab, keys };
}
type DialogState = ReturnType<typeof useDialogState>;
type DialogPart = { state: DialogState };

function reviewerMessage({ source, draft }: DialogState) {
  const { label, catalog, seatName, info } = source, { block, working } = draft;
  const model = label(working.reviewer?.model ?? '');
  const { shown, total } = topAlternatives(block?.alternatives ?? [], 3, { fix: block?.fix ?? null, map: working, catalog, defaults: info.defaults });
  const names = shown.map(row => label(row.model)).join('、');
  return t('审查（{model}）与{seats}使用同一模型，账户里还有不弱于它的 {others}，所以不能保存。', {
    model, seats: block?.hit.map(seatName).join('、') ?? '', others: total > shown.length ? t('{names} 等 {count} 个', { names, count: total }) : names });
}

function seatControls(state: DialogState) {
  const { info, catalog, label, slotName } = state.source, { working, baseline, block } = state.draft;
  const { startDrag, dragged } = state.drag, { menu, openMenu } = state.popup;
  const { edit } = state.edits;
  // What the seat says under its model: why it is not what the owner chose.
  const slotState = (slot: SlotId) => {
    const seat = getSlot(working, slot);
    if (!seat) return null;
    if (slot === 'reviewer' && block) return { kind: 'bad', short: t('已阻止 · 同模型'), title: reviewerMessage(state) };
    if (slot === 'reviewer' && reviewerSameButAllowed(working, catalog)) return { kind: 'warn', short: t('同模型 · 无更强可换'), title: t('账户里没有不弱于它的其他模型，允许保留') };
    const issues = sameSeat(seat, getSlot(baseline, slot)) ? issuesOf(info, slot) : [];
    if (issues.length) return { kind: 'warn', short: t('已调整 · {substitute}', { substitute: issues[0].substitute }), title: issues.map(issueText).join('；') };
    if (isAvailable(catalog, seat.model)) return null;
    const fallback = fallbackFor({ ...info, catalog }, slot, working), reason = modelRow(catalog, seat.model)?.reason ?? '';
    if (fallback) return { kind: 'warn', short: t('回退 {model}', { model: label(fallback.model) }), title: t('{model}（{reason}）；实际使用 {fallback}', { model: label(seat.model), reason, fallback: label(fallback.model) }) };
    return { kind: 'warn', short: t('暂不使用'), title: `${label(seat.model)}${reason ? `（${reason}）` : ''}` };
  };
  const stateMark = (state: NonNullable<ReturnType<typeof slotState>>) => <span className={`seats-state is-${state.kind}`} title={state.title}>
    {state.kind === 'bad' ? <Prohibit size={14} aria-hidden="true" /> : <Warning size={14} aria-hidden="true" />}<span>{state.short}</span></span>;

  const modelButton = (slot: SlotId, model?: string) => <button type="button" className="seats-gem" data-pick={slot} aria-haspopup="menu"
    aria-expanded={menu?.slot === slot && menu.kind === 'model'} title={model ? label(model) : undefined}
    aria-label={t('{seat}：选择模型', { seat: slotName(slot) })}
    onPointerDown={event => { if (model) startDrag(event, model, slot); }}
    onClick={event => { if (!dragged.current || event.detail === 0) openMenu(slot, event.currentTarget); }}>
    {model && <i className="seats-mk" data-family={rowFor(catalog, model)?.family} aria-hidden="true" />}
    <span className="seats-gem-name">{model ? label(model) : t('未设置')}</span><CaretDown size={14} aria-hidden="true" />
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
  return { slotState, stateMark, modelButton, effortButton, fastSwitch };
}

function TeamChart({ state }: DialogPart) {
  const { roles, seats, info, operations } = state.source, { working, baseline, block } = state.draft, { over } = state.drag;
  const { slotState, stateMark, modelButton, effortButton, fastSwitch } = seatControls(state);
  const lead = roles.find(role => role.id === info.lead), team = seats.filter(id => id !== info.lead).flatMap(id => roles.filter(role => role.id === id));
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
  return <div className="seats-chart" id="seats-team-panel" role={operations && 'tabpanel'} aria-labelledby={operations && 'seats-team-tab'}>
    <div className="seats-owner" data-owner>
      <span className="seats-role-icon"><User size={18} aria-hidden="true" /></span>
      <div><h3>Human / Owner</h3><p>{t('目标、预算、重大决策、最终授权')}</p></div>
    </div>
    {lead && <><div className="seats-chart-link" aria-hidden="true" />{card(lead, true)}<div className="seats-chart-bus" aria-hidden="true" /></>}
    <div className="seats-team-grid">{team.map(role => card(role))}</div>
  </div>;
}

function ModelPalette({ state }: DialogPart) {
  const { catalog } = state.source, { paletteBox, paletteOpen, setPaletteOpen } = state.panels, { startDrag } = state.drag;
  const { query, setQuery, folds, setFolds } = state.panels;
  // 模型盘: grouped by family and model line (Opus, Sonnet… / Sol, Astra…), the newest of each line first, older versions folded.
  const searching = query.trim() !== '';
  const chip = (row: SeatModel, old = false) => {
    const off = !row.available, name = shortLabel(row.label);
    return <span key={row.model} className={`seats-chip${old ? ' is-old' : ''}${off ? ' is-off' : ''}`} data-chip={row.model} data-family={row.family} aria-disabled={off || undefined}
      title={off ? t('{model}（{reason}）不能放入座位', { model: name, reason: row.reason ?? '' }) : t('{model} · 拖到座位上', { model: name })} onPointerDown={event => startDrag(event, row.model, null)}>
      <i className="seats-mk" data-family={row.family} /><span className="seats-chip-name">{name}</span>{row.listed === false && <small data-unlisted>{t('不在最新列表')}</small>}</span>;
  };
  return <aside ref={paletteBox} className={paletteOpen ? "seats-palette is-open" : "seats-palette"} aria-label={t('模型盘')}>
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
}

function DialogHeader({ state }: DialogPart) {
  const { info, refresh, refreshing } = state.source, { close } = state.panels;
  return (
  <header className="seats-head">
    <div><h2 id="seats-title">{t('模型路由')}</h2></div>
    <span className="seats-age" data-catalog-at>{`${t('模型列表更新于')} Claude ${ageText(info.catalogAt?.claude ?? null)} · Codex ${ageText(info.catalogAt?.codex ?? null)}`}</span>
    <span className="seats-grow" />
    <div className="seats-head-actions">
      <button type="button" className="seats-btn" data-refresh disabled={refreshing === 'manual'} aria-label={t('刷新模型列表')}
        onClick={() => { void refresh(); }}><ArrowsClockwise size={14} aria-hidden="true" />{t('刷新')}</button>
      <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={close}><X size={14} aria-hidden="true" /></button>
    </div>
  </header>
  );
}

function ConversationChoices({ state }: DialogPart) {
  const { info, seats, seatName, label, operations } = state.source, { working } = state.draft;
  const { nowBox, setNowOpen, nowButton } = state.panels;
  const { terminalId } = state.props;
  const current = info.current;
  const seatTags = current && seats.filter(id => current[id]).map(id => {
    const seat = current[id], next = working[id];
    const text = (value: typeof seat) => value ? [label(value.model), effortLine(value)].join(' · ') : '—';
    return <span key={id} className={sameSeat(seat, next) ? 'seats-now' : 'seats-now is-diff'}><b>{seatName(id)}</b>{text(seat)}
      {!sameSeat(seat, next) && <> → {text(next)}</>}</span>;
  });
  return <div ref={nowBox} className="seats-nowbox" role="region" aria-label={t('本次对话（只读）')}>
    <div className="seats-menu-head"><b>{t('本次对话（只读）')}</b>
      <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={() => { setNowOpen(false); nowButton.current?.focus(); }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
    {seatTags && <div className="seats-nows">{seatTags}</div>}
    {!seatTags && !operations?.current && <span>{terminalId ? t('这个终端还没有运行中的对话') : t('没有选定终端')}</span>}
    <CurrentOperations info={operations} label={label} />
  </div>;
}

function ReviewOperationBanner({ state }: DialogPart) {
  const { reviewBlock, block } = state.draft;
  if (!reviewBlock || reviewBlock.follow) return null;
  const { label, seatName } = state.source;
  const fix = reviewBlock.fix ? t('审查改用 {model}', { model: label(reviewBlock.fix.model) })
    : block?.fix ? t('将审查席位改为 {model} 并跟随该席位', { model: label(block.fix.model) }) : t('跟随审查席位');
  return <div className="seats-banner is-bad" role="alert" data-operation-block>
    <Prohibit size={14} aria-hidden="true" />
    <span><b>{t('审查模型已阻止。')}</b>{t('审查（{model}）与{seat}使用同一模型，账户里还有不弱于它的模型。', {
      model: label(reviewBlock.model), seat: seatName('developer'),
    })}</span>
    <button type="button" className="seats-btn" data-op-fix onClick={state.edits.fixOperationReview}>{fix}</button>
  </div>;
}

function DialogStrip({ state }: DialogPart) {
  const { operations, moved, label, seatName, notice } = state.source;
  const { block, reviewBlock, count, dirty, scope, saving, refusal, canReset, discardShown, setDiscarding, save } = state.draft;
  const { nowButton, nowOpen, setNowOpen, paletteButton, paletteOpen, setPaletteOpen, keepButton } = state.panels;
  const { projectId, migration, onDismissMigration, onClose } = state.props;
  const { fix } = state.edits, { setMenu } = state.popup;
  const changeScope = (scope: Scope) => { setMenu(null); state.draft.changeScope(scope); };
  const reset = () => { setMenu(null); state.draft.reset(); };
  const blockMessage = () => reviewerMessage(state);
  return (
    <section className="seats-strip" aria-label={t('下一次对话生效')}>
      <div className="seats-strip-row">
        <span className="seats-effective"><i className={`seats-dot ${block || reviewBlock ? 'is-bad' : dirty ? 'is-on' : 'is-ok'}`} />{t('下一次对话生效')}</span>
        <span>{block ? t('有座位被阻止，不能保存') : reviewBlock ? t('审查模型被阻止，不能保存') : dirty
          ? t(operations ? '草稿未保存 · 已改 {count} 项' : '草稿未保存 · 已改 {count} 个座位', { count }) : t('没有改动')}</span>
        <span className="seats-grow" />
        <button type="button" ref={nowButton} className="seats-btn is-small" data-now aria-expanded={nowOpen}
          onClick={() => setNowOpen(!nowOpen)}>{t('本次对话')}<CaretDown size={12} aria-hidden="true" /></button>
        <button type="button" ref={paletteButton} className="seats-btn is-small" data-palette-toggle aria-pressed={paletteOpen} onClick={() => setPaletteOpen(!paletteOpen)}>{t('模型盘')}</button>
        <label className="seats-scope">{t('范围')}<select aria-label={t('设置范围')} value={scope} disabled={saving} onChange={event => changeScope(event.target.value as Scope)}>
          <option value="global">{t('全局 · 所有项目')}</option>{projectId && <option value="project">{t('本项目 · 覆盖全局')}</option>}</select></label>
        <button type="button" className="seats-btn" data-reset disabled={saving || !canReset}
          onClick={reset}><ArrowCounterClockwise size={14} aria-hidden="true" />{t('恢复默认')}</button>
        <button type="button" className="seats-btn is-primary" data-save disabled={!dirty || !!refusal || !!reviewBlock || saving}
          title={block ? blockMessage() : undefined} onClick={() => { void save(); }}>{t('保存')}</button>
      </div>
      {nowOpen && <ConversationChoices state={state} />}
      <ReviewOperationBanner state={state} />
      {moved.length > 0 && <div className="seats-banner" role="status" data-moved><CheckCircle size={14} aria-hidden="true" />
        <span>{t('默认已更新为 {changes}', { changes: moved.map(item => `${seatName(item.seat)}：${label(item.from)} → ${label(item.to)}`).join('；') })}</span></div>}
      {migration && <div className="seats-banner" role="status" data-migrated>
        <div>{migration.split('\n').map(line => <p key={line}>{migrationLine(line)}</p>)}</div>
        <button type="button" className="seats-btn" onClick={onDismissMigration}>{t('知道了')}</button>
      </div>}
      {block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" />
        <span><b>{t('审查座位被阻止。')}</b>{blockMessage()}{!block.fix && ` ${t('请先改动{seats}的模型。', { seats: block.hit.map(seatName).join('、') })}`}</span>
        {block.fix && <button type="button" className="seats-btn" data-fix={block.fix.model} onClick={fix}>{t('审查改用 {model}', { model: label(block.fix.model) })}</button>}</div>}
      {refusal && !block && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" /><span>{refusal.message}</span></div>}
      {discardShown && <div className="seats-banner is-warn" role="alertdialog" aria-label={t('放弃未保存的修改？')}><Warning size={14} aria-hidden="true" />
        <span>{t(operations ? '有 {count} 项修改还没保存，关闭会丢掉它们。' : '有 {count} 个座位的修改还没保存，关闭会丢掉它们。', { count })}</span>
        <button ref={keepButton} type="button" className="seats-btn" data-keep onClick={() => setDiscarding(false)}>{t('继续编辑')}</button>
        <button type="button" className="seats-btn" data-discard onClick={onClose}>{t('放弃修改')}</button></div>}
      <p className="seats-notice" role="status" aria-live="polite" data-kind={notice?.kind}>{notice?.kind === 'ok' && <CheckCircle size={14} aria-hidden="true" />}{notice?.text}</p>
    </section>
  );
}

function DialogMenu({ state }: DialogPart) {
  const { menu, menuBox, custom, setCustom, closeMenu, menuKeys } = state.popup;
  const { catalog, slotName, opAt, label } = state.source, { working, opValues } = state.draft;
  const { assign, updateOperation, edit, submitCustom } = state.edits;
  if (!menu) return null;
  const pick = (slot: SlotId, model: string) => { assign(slot, model); closeMenu(); };
  const menuOp = opAt(menu.slot), menuValue = menuOp ? opValues[menuOp.id] : undefined;
  const menuSeat = menu && !menuOp ? getSlot(working, menu.slot) : undefined;
  const menuModel = menuSeat ? rowFor(catalog, menuSeat.model) : undefined;
  const selected = menuValue === 'follow' ? undefined : menuValue?.model ?? menuSeat?.model;
  const menuEffort = menuValue === 'follow' ? undefined : menuValue?.effort ?? menuSeat?.effort;
  const efforts = selected ? rowFor(catalog, selected)?.efforts ?? [] : [];
  const changeMenuEffort = (effort: string) => {
    if (!menu || !efforts.includes(effort)) return;
    if (menuOp && selected) updateOperation(menuOp, { model: selected, effort });
    else edit(setEffort(working, menu.slot, effort, catalog));
    closeMenu();
  };
  const menuAgent = menu?.kind === 'claude' || menu?.kind === 'codex' ? menu.kind : null;
  const menuStyle = { left: menu.left, top: menu.top, bottom: menu.bottom, width: menu.width, maxHeight: menu.maxHeight };
  const fastNote = menuModel && (!menuModel.fast ? t(FAST_REASONS[menuModel.fastReason ?? 'unsupported']) : menuModel.family === 'claude' ? t(FAST_BILLING) : null);
  return <>
  {menu && menu.kind === 'model' && <div key={menu.slot} ref={menuBox} className={menuOp ? 'seats-menu is-operation' : 'seats-menu'} role="menu"
    aria-label={t('{seat}：选择模型', { seat: slotName(menu.slot) })} style={menuStyle} onKeyDown={menuKeys}>
    <MenuHeader title={t('{seat}：选择模型', { seat: slotName(menu.slot) })} close={closeMenu} />
    <div className="seats-menu-list">
    {menuOp?.follow && <button type="button" role="menuitemradio" className="seats-menu-item" data-op-follow
      aria-checked={menuValue === 'follow'} onClick={() => { updateOperation(menuOp, 'follow'); closeMenu(); }}>{operationLabel(menuOp, 'follow', label)}</button>}
    {modelMenuItems(catalog, selected, model => pick(menu.slot, model), menuOp || undefined)}
    {custom ? <div className="seats-menu-custom">
      <input type="text" data-custom-input maxLength={160} autoFocus spellCheck={false} aria-label={t('模型名')} placeholder={t('模型名，例如 gpt-6.3-sol')} value={custom.text}
        onChange={event => setCustom({ text: event.target.value, error: '' })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitCustom(menu.slot); } }} />
      <button type="button" className="seats-btn is-small" data-custom-apply onClick={() => submitCustom(menu.slot)}>{t('使用')}</button>
      {custom.error && <small className="seats-menu-error" role="alert" data-custom-error>{custom.error}</small>}
    </div> : <button type="button" role="menuitem" className="seats-menu-item" data-custom onClick={() => setCustom({ text: '', error: '' })}>{t('其他模型…')}</button>}
    </div>
    {menuSeat && <div className="seats-menu-settings">
      <select data-effort={menu.slot} aria-label={t('{seat}的推理强度', { seat: slotName(menu.slot) })} value={menuSeat.effort}
        onChange={event => edit(setEffort(working, menu.slot, event.target.value, catalog))}>
        {(menuModel?.efforts ?? [menuSeat.effort]).map(effort => <option key={effort} value={effort}>{t('强度 {effort}', { effort })}</option>)}</select>
      <button type="button" className="seats-switch" role="switch" aria-checked={!!menuSeat.fast} data-fast={menu.slot}
        disabled={!menuModel?.fast && !menuSeat.fast} aria-label={t('{seat}快速模式', { seat: slotName(menu.slot) })}
        onClick={() => edit(setFast(working, menu.slot, !menuSeat.fast, catalog))}>{t('快速')}<i /></button>
      {fastNote && <small className="seats-menu-note" data-fast-note>{fastNote}</small>}
    </div>}
  </div>}
  {menu?.kind === 'effort' && <div ref={menuBox} className="seats-menu is-effort" role="menu"
    aria-label={t('{seat}：选择强度', { seat: slotName(menu.slot) })} style={menuStyle} onKeyDown={menuKeys}>
    <MenuHeader title={t('{seat}：选择强度', { seat: slotName(menu.slot) })} close={closeMenu} />
    <div className="seats-menu-list">{efforts.map(effort => <button key={effort} type="button" role="menuitemradio" className="seats-menu-item"
      aria-checked={effort === menuEffort} data-pop-effort={effort}
      onClick={() => changeMenuEffort(effort)}>{effort}{effort === menuEffort && <small>{t('当前')}</small>}</button>)}</div>
    {menuSeat && <div className="seats-menu-settings">
      <button type="button" className="seats-switch" role="switch" aria-checked={!!menuSeat.fast} data-pop-fast={menu.slot}
        disabled={!menuModel?.fast && !menuSeat.fast} aria-label={t('{seat}快速模式', { seat: slotName(menu.slot) })}
        onClick={() => edit(setFast(working, menu.slot, !menuSeat.fast, catalog))}>{t('快速')}<i /></button>
      <small className="seats-menu-note" data-fast-note>{fastNote ?? t('开启后更快，用量与计费可能不同')}</small>
    </div>}
  </div>}
  {menuOp && menuAgent && <div ref={menuBox} className="seats-menu" role="region" aria-label={t('未生效')} style={menuStyle}>
    <MenuHeader title={`${operationName(menuOp)} · ${menuAgent === 'claude' ? 'Claude' : 'Codex'} · ${t('未生效')}`} close={closeMenu} />
    <p className="seats-op-reason">{operationWords(menuOp.agents[menuAgent].reason ?? '')}</p>
  </div>}
  </>;
}

export function SeatsDialog(props: SeatsDialogProps) {
  const state = useDialogState(props);
  const { catalog, operations, opAt, label } = state.source, { opValues, ops, reviewBlock, working } = state.draft;
  const { dialog, nowOpen, paletteOpen, close } = state.panels, { menu, openMenu } = state.popup;
  const { over, ghost } = state.drag, { tab, switchTab, keys } = state;
  const menuOp = menu ? opAt(menu.slot) : undefined;
  const control = menuOp && menu ? { id: menuOp.id, kind: menu.kind } : undefined;
  return createPortal(
    <div className="seats-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !menu && !nowOpen && !paletteOpen) close(); }}>
      <div ref={dialog} className="seats-dialog" role="dialog" aria-modal="true" aria-labelledby="seats-title" tabIndex={-1} onKeyDown={keys}>
        <DialogHeader state={state} />
        <div className="seats-body">
          <DialogStrip state={state} />
          {operations && <RoutingTabs tab={tab} choose={switchTab} />}
          <div className="seats-work">
            {tab === 'operations' && operations ? <OperationRows info={operations} values={opValues} baseline={ops.baseline} catalog={catalog} label={label}
              reviewBlocked={!!reviewBlock} reviewerModel={working.reviewer?.model}
              over={over ? opAt(over)?.id : undefined} control={control} open={(id, button, kind) => openMenu(operationSlot(id), button, kind)}
              select={(id, model) => state.edits.assign(operationSlot(id), model)} /> : <TeamChart state={state} />}
            <ModelPalette state={state} />
          </div>
        </div>
        <DialogMenu state={state} />
        {ghost && <span className="seats-ghost" style={{ left: ghost.x, top: ghost.y }} data-family={modelRow(catalog, ghost.model)?.family}>
          <i className="seats-mk" data-family={modelRow(catalog, ghost.model)?.family ?? familyOf(ghost.model)} />{label(ghost.model)}
        </span>}
      </div>
    </div>, document.body);
}
