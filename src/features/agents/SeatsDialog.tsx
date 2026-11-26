import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowCounterClockwise, ArrowsClockwise, BookOpen, Browser, CaretDown, CheckCircle, ClipboardText, DotsThree, Code, Cpu, Database, Desktop, FileText, Flask, Gauge, GitBranch,
  HardDrives, Infinity as InfinityIcon, LockSimple, MagnifyingGlass, PencilSimple, Person, Plus, Prohibit, ShieldCheck, SidebarSimple, Stack, User, Warning, X,
} from '@phosphor-icons/react';
import { aliasTarget, modelLabel } from '../../shared/routing-command.ts';
import { routingNotice, unverifiedSwitchWords } from '../../shared/lead-routing-notices.ts';
import { unverifiedScreenSwitch } from '../cli-screens/index.ts';
import { useScreen } from '../terminal/terminal-screen.ts';
import type { RoleConfig, RoutingAction, RoutingConfig, SeatId, SeatIssue, SeatMap, SeatModel, SeatsInfo, TeamRole } from '../../shared/types';
import { t, currentLanguage } from '../../shared/i18n';
import {
  paletteGroups, ageOf, menuPlacement, withInstalled, assignCustom, assignModel, baselineFor, cleanDraft, configFor, draftRoles, resolveDraftSeats, updateDraftSeats,
  changedSeats, fallbackFor, firstRefusal, getSlot, isAvailable, issuesOf, modelRow, rowFor,
  sameSeat, saveSeats, setEffort, setFast, startScope, swapSlots, agentOfModel, allowsUltracode, withSlot,
  displayedSeat, seatSettingText, type Edit, type Scope, type SlotId,
} from './routing-seats';
import { checkTeamRules, MAX_CUSTOM_ROLES, MAX_ENABLED_ROLES, nextRoleId } from '../../../electron/features/routing/role-rules.mjs';
import { copyRole, roleName, RoleEditor, sameRoleConfig } from './RoleEditor';
import { resolveRouting, RoutingReview, routingError, routingLayer } from './RoutingReview';
import './seats-dialog.css';

const ROLE_ICONS = { orchestrator: GitBranch, product: ClipboardText, architect: Stack, designer: PencilSimple, developer: Code,
  reviewer: MagnifyingGlass, qa: Flask, researcher: BookOpen, devops: InfinityIcon, security: ShieldCheck,
  frontend: Browser, backend: HardDrives, desktop: Desktop, database: Database, ai: Cpu, docs: FileText, performance: Gauge, a11y: Person };
const enabledLimit = () => t('已启用 {limit} 个角色（上限 {limit}）；停用一个后才能再启用', { limit: MAX_ENABLED_ROLES });
const customLimit = () => t('已创建 {limit} 个项目角色（上限 {limit}）；删除一个后才能新建', { limit: MAX_CUSTOM_ROLES });
const roleSeparator = () => currentLanguage() === 'en' ? ', ' : '、';

function RoleIcon({ id }: { id: string }) {
  const Icon = ROLE_ICONS[id as keyof typeof ROLE_ICONS] ?? User;
  return <span className="seats-role-icon"><Icon size={18} aria-hidden="true" /></span>;
}
const ROLE_NAMES: Record<string, string> = {
  orchestrator: 'Orchestrator', product: 'Product', architect: 'Architect', designer: 'Designer', developer: 'Developer',
  reviewer: 'Reviewer', qa: 'QA / Tester', researcher: 'Researcher', devops: 'DevOps', security: 'Security',
  frontend: 'Frontend', backend: 'Backend', desktop: 'Desktop', database: 'Database', ai: 'AI', docs: 'Docs', performance: 'Performance', a11y: 'Accessibility',
};
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
type Menu = { kind: 'model' | 'role'; slot: SlotId } & ReturnType<typeof menuPlacement>;
type Custom = { text: string; error: string };
const inside = (node: unknown, target: unknown) => !!node && typeof (node as Node).contains === 'function' && (node as Node).contains(target as Node);

function modelMenuItems(catalog: SeatModel[], selected: string | undefined, pick: (model: string) => void, unavailable?: string) {
  const current = selected && (aliasTarget(catalog, selected) ?? selected);
  return catalog.filter(row => !aliasTarget(catalog, row.model)).map(row => <button key={row.model} type="button" role="menuitemradio" className="seats-menu-item" aria-checked={row.model === current}
    data-assign={row.model} title={unavailable ?? modelLabel(catalog, row.model)} disabled={!!unavailable || !row.available} onClick={() => pick(row.model)}>
    <i className="seats-mk" data-family={row.family} />
    <span className="seats-menu-model">{modelLabel(catalog, row.model)}</span>
    <span className="seats-menu-details">
      {!row.available && <small>{row.reason}</small>}
      {row.listed === false && <small data-unlisted>{t('不在最新列表')}</small>}
      {row.available && row.listed !== false && row.model === current && <small>{t('当前')}</small>}
    </span>
  </button>);
}

type Tab = 'team' | 'library';

function RoutingTabs({ tab, choose, counts }: { tab: Tab; choose: (tab: Tab) => void; counts: Record<Tab, number> }) {
  const tabs: Tab[] = ['team', 'library'];
  const labels = { team: '团队', library: '角色库' };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : index];
    choose(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-routing-tab="${next}"]`)?.focus();
  };
  return <div className="seats-tabs" role="tablist" aria-label={t('模型路由')} onKeyDown={onKeyDown}>
    {tabs.map(id => <button key={id} type="button" className="seats-btn"
      id={`seats-${id}-tab`} data-routing-tab={id} role="tab" aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
      aria-controls={`seats-${id}-panel`} onClick={() => choose(id)}>{t(labels[id])}<span className="seats-tab-count">{counts[id]}</span></button>)}
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
  onError: (message: string) => void;
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
    if (!window.agentrix?.routingSeats) return;
    const version = ++readVersion.current;
    const next = await window.agentrix.routingSeats(projectId ?? null, terminalId).catch(() => null);
    rememberMoved(next);
    if (!next || !alive.current || version !== readVersion.current) return;
    if (next.migrated) onMigration(next.migrated);
    setRefreshed(next);
    return next;
  };
  useEffect(() => {
    alive.current = true;
    void refresh(true);
    const off = window.agentrix?.onRouting?.(() => { void loadInfo(); });
    return () => { alive.current = false; readVersion.current++; off?.(); };
  }, []);
  useEffect(() => { setRefreshed(null); rememberMoved(given); }, [given]);

  const info = refreshed ?? given;
  const catalog = withInstalled(info.catalog, info.installed, family => t('{agent} 未安装', { agent: family === 'codex' ? 'Codex' : 'Claude' }));
  const roles = info.roles ?? [];
  const label = (model: string) => modelLabel(catalog, model);

  const refresh = async (opening = false) => {
    if (reading.current) { if (!opening) queued.current = true; return; }
    if (!window.agentrix?.refreshRouting) return;
    reading.current = opening ? 'dialog' : 'manual';
    setRefreshing(reading.current);
    const version = ++readVersion.current;
    try {
      const next = await window.agentrix.refreshRouting(projectId ?? null, terminalId ?? null, opening ? 'dialog' : 'manual');
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
  return { info, catalog, roles, label, notice, setNotice, refreshing, refresh, moved, alive, loadInfo };
}

type ScopeDraft = { config: RoutingConfig; base: string | null };

function useDraft(source: ReturnType<typeof useCatalog>, projectId?: string) {
  const { info, catalog, alive, setNotice, loadInfo } = source;
  const [scope, setScope] = useState<Scope>(() => startScope(info, projectId));
  const [drafts, setDrafts] = useState<Partial<Record<Scope, ScopeDraft>>>({});
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [stale, setStale] = useState(false);
  const original = configFor(info, scope), current = drafts[scope], config = current?.config ?? original;
  const roles = draftRoles(info, config), working = resolveDraftSeats(info.defaults, roles, config), baseline = baselineFor(info, scope);
  const enabled = roles.filter(role => role.enabled), live = Object.fromEntries(enabled.flatMap(role => working[role.id] ? [[role.id, working[role.id]]] : []));
  const clean = cleanDraft(info, config);
  const saved = cleanDraft(info, original);
  const roleIds = new Set([...Object.keys(clean.roles), ...Object.keys(saved.roles)]);
  const count = [...roleIds].filter(id => !sameRoleConfig(clean.roles[id], saved.roles[id])).length + Number(!!clean.conductor !== !!saved.conductor);
  const dirty = !!current && count > 0;
  const teamError = checkTeamRules(roles);
  const refusal = firstRefusal(live, catalog);
  const createFile = scope === 'project' && !info.routing.remote && info.routing.state === 'absent';
  const { state: routingState, actions } = info.routing;
  const mayOverwrite = scope === 'template' || routingState === 'trusted' || routingState === 'absent' ||
    routingState === 'rejected' && actions.includes('overwrite');
  const setConfig = (next: RoutingConfig, base = info.routing.digest) => setDrafts(previous => ({
    ...previous, [scope]: { config: next, base: previous[scope] ? previous[scope]!.base : base },
  }));
  const setDraft = (next: SeatMap) => setConfig(updateDraftSeats(config, working, next));
  const reset = () => {
    setConfig({ roles: {} });
    setDiscarding(false);
    setNotice({ kind: 'info', text: t('草稿已恢复默认设置') });
  };
  const reload = async () => {
    if (!await loadInfo() || !alive.current) return;
    setDrafts(previous => ({ ...previous, project: undefined }));
    setStale(false);
    setNotice({ kind: 'ok', text: t('已重新载入配置') });
  };
  const save = async () => {
    if ((!dirty && !createFile) || refusal || teamError || saving || !mayOverwrite) return;
    setNotice(null);
    setSaving(true);
    const result = await saveSeats(window.agentrix, scope, projectId ?? null, clean, current ? current.base : info.routing.digest);
    if (!alive.current) return;
    if (result.ok) {
      await loadInfo();
      if (!alive.current) return;
      setDrafts(previous => ({ ...previous, [scope]: undefined }));
    }
    setSaving(false);
    if (result.ok) return;
    if (result.error?.code === 'file-changed') setStale(true);
    const message = result.error ? routingError(result.error) : result.message;
    setNotice({ kind: 'error', text: t('没有保存：{message}', { message }) });
  };
  return {
    baseline, working, roles, config, enabled, dirty, count, refusal, teamError, scope, saving, createFile, mayOverwrite, stale, reload,
    hasDrafts: dirty || !!drafts[scope === 'project' ? 'template' : 'project'],
    canReset: Object.keys(clean.roles).length > 0 || !!clean.conductor,
    discardShown: discarding, setDiscarding, setDraft, setConfig, changeScope: setScope, reset, save,
  };
}

function routingNames(source: ReturnType<typeof useCatalog>, draft: ReturnType<typeof useDraft>) {
  const seatName = (id: SeatId) => {
    const role = draft.roles.find(item => item.id === id) ?? source.roles.find(item => item.id === id);
    return role ? roleName(role) : id;
  };
  return { seatName };
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

function useMenu({ catalog }: ReturnType<typeof useCatalog>, { setNowOpen }: ReturnType<typeof usePanels>) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [custom, setCustom] = useState<Custom | null>(null);
  const [modelFolds, setModelFolds] = useState<Record<string, boolean>>({});
  const menuBox = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const itemSelector = ':is([role="menuitemradio"], [role="menuitem"]):not(:disabled)';
  useEffect(() => {
    if (!menu) return;
    const items = Array.from(menuBox.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
    const first = items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0];
    const target = first ?? menuBox.current?.querySelector<HTMLElement>('[data-menu-close]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
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
    setModelFolds({});
    const rows = kind === 'model' ? catalog.length : 6;
    setNowOpen(false);
    setMenu({ kind, slot, ...menuPlacement({ left: box.left, top: box.top, bottom: box.bottom }, { width: window.innerWidth, height: window.innerHeight }, rows) });
  };
  const closeMenu = () => { setMenu(null); setCustom(null); opener.current?.focus({ preventScroll: true }); };
  const menuKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(itemSelector));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next.focus({ preventScroll: true });
    next.scrollIntoView?.({ block: 'nearest' });
  };
  return { menu, setMenu, custom, setCustom, menuBox, openMenu, closeMenu, menuKeys, modelFolds, setModelFolds };
}

type SwitchReason = (slot: SlotId, control: Parameters<typeof unverifiedScreenSwitch>[1]) => string | undefined;

function choiceActions(
  source: ReturnType<typeof useCatalog> & ReturnType<typeof routingNames>, draft: ReturnType<typeof useDraft>, popup: ReturnType<typeof useMenu>, switchReason: SwitchReason,
) {
  const { label, seatName, catalog, setNotice } = source;
  const { working, setDraft, setDiscarding, saving } = draft;
  const { custom, setCustom, closeMenu } = popup;
  const refusalText = (result: Extract<Edit, { ok: false }>, model: string) => {
    if (result.reason === 'same') return null;
    if (result.reason === 'unavailable') return t('{model}（{reason}）不能放入座位', { model: label(model), reason: modelRow(catalog, model)?.reason ?? t(REFUSALS.unavailable) });
    return t(REFUSALS[result.reason]);
  };
  const apply = (result: Edit, success: string, model = '') => {
    if (saving) return;
    if (result.ok) { setDraft(result.map); setDiscarding(false); setNotice({ kind: 'info', text: success }); return; }
    const text = refusalText(result, model);
    if (text) setNotice({ kind: 'error', text });
  };
  const assign = (slot: SlotId, model: string) => {
    const reason = switchReason(slot, 'liveModel');
    if (reason) { setNotice({ kind: 'error', text: reason }); return; }
    apply(assignModel(working, slot, model, catalog), t('草稿 · {seat} 换成 {model}', { seat: seatName(slot), model: label(model) }), model);
  };
  const swap = (from: SlotId, slot: SlotId) => {
    const reason = switchReason(from, 'liveModel') ?? switchReason(slot, 'liveModel');
    if (reason) { setNotice({ kind: 'error', text: reason }); return; }
    const result = swapSlots(working, from, slot, catalog);
    apply(result, t('草稿 · {first} 与 {second} 互换了模型', { first: seatName(from), second: seatName(slot) }));
  };
  const drop = (slot: SlotId, model: string, from: SlotId | null) => { if (from) swap(from, slot); else assign(slot, model); };
  // 其他模型…: a refused id stays in the box with its reason; an accepted one is assigned like a listed model.
  const submitCustom = (slot: SlotId) => {
    const model = (custom?.text ?? '').trim();
    const reason = switchReason(slot, 'liveModel');
    if (reason) { setCustom({ text: model, error: reason }); return; }
    const result = assignCustom(working, slot, model, catalog);
    if (!result.ok && result.reason !== 'same') { setCustom({ text: model, error: refusalText(result, model) ?? '' }); return; }
    apply(result, t('草稿 · {seat} 换成 {model}', { seat: seatName(slot), model: label(model) }));
    closeMenu();
  };
  const edit = (result: Edit) => { if (!saving && result.ok) { setDraft(result.map); setDiscarding(false); } };
  return { assign, drop, submitCustom, edit };
}

function useModelDrag(catalog: SeatModel[], drop: ReturnType<typeof choiceActions>['drop']) {
  const [over, setOver] = useState<SlotId | null>(null);
  const [ghost, setGhost] = useState<{ model: string; x: number; y: number } | null>(null);
  const clear = useRef<(() => void) | null>(null);
  useEffect(() => () => clear.current?.(), []);
  const dragged = useRef(false);
  const slotAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot]')?.dataset.slot;
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

type EditorState = { id: string; initial: RoleConfig; existing?: TeamRole; replace?: string; idLocked?: boolean; base: string | null };

function useRoleActions(source: ReturnType<typeof useCatalog>, draft: ReturnType<typeof useDraft>, { dialog }: ReturnType<typeof usePanels>) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  const taken = [...new Set([
    ...Object.keys(draft.config.roles), ...Object.keys(source.info.template.roles), ...Object.keys(source.info.config?.roles ?? {}),
    ...(source.info.currentRoles ?? []).map(role => role.id),
  ])];
  const open = (next: Omit<EditorState, 'base'>) => {
    if (!editor) opener.current = document.activeElement as HTMLElement | null;
    setEditor({ ...next, base: source.info.routing.digest });
  };
  useEffect(() => {
    if (editor || opener.current === undefined) return;
    const target = opener.current?.isConnected ? opener.current : dialog.current;
    target?.focus({ preventScroll: true });
    opener.current = undefined;
  }, [editor]);
  const close = () => setEditor(null);
  const edit = (role: TeamRole) => open({
    id: role.id, existing: role, idLocked: Object.hasOwn(configFor(source.info, draft.scope).roles, role.id),
    initial: role.source === 'custom' ? draft.config.roles[role.id] : { name: role.name, duty: role.detail || role.duty, outputs: role.outputs },
  });
  const create = (from = draft.roles.find(role => role.id === 'developer'), replace?: string) => {
    if (!from || draft.saving || draft.roles.filter(role => role.source === 'custom').length >= MAX_CUSTOM_ROLES) return;
    const id = nextRoleId(from.id, taken);
    open({ id, initial: copyRole(id, { from, roles: draft.roles, replace }), replace });
  };
  const change = (role: TeamRole, value: RoleConfig) => draft.setConfig({
    ...draft.config, roles: { ...draft.config.roles, [role.id]: { ...draft.config.roles[role.id], ...value } },
  });
  const save = (id: string, value: RoleConfig) => {
    const roles = { ...draft.config.roles, [id]: value };
    if (editor?.existing && editor.existing.id !== id) delete roles[editor.existing.id];
    if (editor?.replace) roles[editor.replace] = { ...roles[editor.replace], enabled: false };
    draft.setConfig({ ...draft.config, roles }, editor?.base);
    close();
  };
  const remove = (role: TeamRole) => {
    const roles = { ...draft.config.roles };
    delete roles[role.id];
    draft.setConfig({ ...draft.config, roles });
  };
  return { editor, taken, close, edit, create, change, save, remove };
}

function useReviewCooldown(visible: boolean, digest: string | null) {
  const previous = useRef({ visible, digest });
  const [cooling, setCooling] = useState(false);
  const changedNow = visible && previous.current.visible && previous.current.digest !== digest;
  useEffect(() => {
    previous.current = { visible, digest };
    setCooling(changedNow);
    if (!changedNow) return;
    const timer = setTimeout(() => setCooling(false), 1000);
    return () => clearTimeout(timer);
  }, [visible, digest]);
  return visible && (changedNow || cooling);
}

function useRoutingReview(source: ReturnType<typeof useCatalog>, draft: ReturnType<typeof useDraft>, projectId?: string) {
  const [opened, setOpened] = useState(false), [raw, setRaw] = useState(false), [busy, setBusy] = useState(false);
  const routing = source.info.routing, digest = routing.digest;
  useEffect(() => { setRaw(false); }, [digest, draft.scope]);
  useEffect(() => { setOpened(false); }, [draft.scope]);
  const reviewable = routing.state === 'pending' || routing.state === 'invalid' || opened && routing.state === 'rejected';
  const visible = draft.scope === 'project' && !routing.remote && reviewable;
  const refreshed = useReviewCooldown(visible, digest);
  const act = async (action: RoutingAction) => {
    if (!projectId || busy || refreshed) return;
    setBusy(true);
    try {
      const result = await resolveRouting(window.agentrix, projectId, routing, action);
      await source.loadInfo();
      if (!source.alive.current || !result) return;
      if (!result.ok) source.setNotice({ kind: 'error', text: routingError(result) });
      else { setOpened(false); setRaw(false); source.setNotice(null); }
    } catch (error) {
      if (source.alive.current) source.setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (source.alive.current) setBusy(false);
    }
  };
  const close = () => { setOpened(false); setRaw(false); };
  return { visible, open: () => setOpened(true), close, raw, toggle: () => setRaw(!raw), busy, refreshed, act };
}

function useDialogState(props: SeatsDialogProps) {
  const catalog = useCatalog(props), draft = useDraft(catalog, props.projectId);
  const source = { ...catalog, ...routingNames(catalog, draft) };
  const panels = usePanels({ ...draft, dirty: draft.hasDrafts }, props.onClose), popup = useMenu(source, panels);
  const roles = useRoleActions(source, draft, panels), review = useRoutingReview(source, draft, props.projectId);
  useEffect(() => {
    if (!review.visible) return;
    popup.setMenu(null);
  }, [review.visible]);
  const frame = useScreen(props.terminalId ?? '');
  const switchReason: SwitchReason = (slot, control) => {
    if (draft.scope !== 'project' || !draft.config.conductor || slot !== source.info.lead || !frame?.sessionId || !frame.agent) return;
    const cli = unverifiedScreenSwitch(frame.agent, control, frame.agentVersion);
    return cli ? unverifiedSwitchWords(cli, t) : undefined;
  };
  const edits = choiceActions(source, draft, popup, switchReason), drag = useModelDrag(source.catalog, edits.drop);
  const warnedFast = useRef(false);
  const [tab, setTab] = useState<Tab>('team');
  const switchTab = (next: Tab) => { popup.setMenu(null); panels.setPaletteOpen(false); setTab(next); };
  const { dialog, nowOpen, nowButton, paletteOpen, paletteButton, setNowOpen, setPaletteOpen, close } = panels;
  const { menu, closeMenu } = popup;
  const { discardShown, setDiscarding } = draft;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (review.busy) return;
      if (menu) closeMenu();
      else if (discardShown) setDiscarding(false);
      else if (nowOpen) { setNowOpen(false); nowButton.current?.focus(); }
      else if (paletteOpen) { setPaletteOpen(false); paletteButton.current?.focus(); }
      else close();
      return;
    }
    if (event.key === 'Tab' && !roles.editor) {
      const controls = 'button:not(:disabled):not([tabindex="-1"]), select:not(:disabled), input, [tabindex="0"]';
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(controls) ?? []).filter(item => item.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  return { props, source, draft, panels, popup, edits, drag, tab, switchTab, keys, roles, review, warnedFast, switchReason };
}
type DialogState = ReturnType<typeof useDialogState>;
type DialogPart = { state: DialogState };

function seatControls(state: DialogState) {
  const { info, catalog, label } = state.source, { working, baseline } = state.draft;
  // What the seat says under its model: why it is not what the owner chose.
  const slotState = (slot: SlotId) => {
    const seat = getSlot(working, slot);
    if (!seat) return null;
    const issues = sameSeat(seat, getSlot(baseline, slot)) ? issuesOf(info, slot) : [];
    if (issues.length) return { kind: 'warn', short: t('已调整 · {substitute}', { substitute: issues[0].substitute }), title: issues.map(issueText).join('；') };
    if (isAvailable(catalog, seat.model)) return null;
    const fallback = fallbackFor({ ...info, catalog }, slot, working), reason = modelRow(catalog, seat.model)?.reason ?? '';
    if (fallback) return { kind: 'warn', short: t('回退 {model}', { model: label(fallback.model) }), title: t('{model}（{reason}）；实际使用 {fallback}', { model: label(seat.model), reason, fallback: label(fallback.model) }) };
    return { kind: 'warn', short: t('暂不使用'), title: `${label(seat.model)}${reason ? `（${reason}）` : ''}` };
  };
  const stateMark = (state: NonNullable<ReturnType<typeof slotState>>) => <span className={`seats-state is-${state.kind}`} title={state.title}>
    {state.kind === 'bad' ? <Prohibit size={14} aria-hidden="true" /> : <Warning size={14} aria-hidden="true" />}<span>{state.short}</span></span>;

  return { slotState, stateMark };
}

function SeatPicker({ state, role }: DialogPart & { role: TeamRole }) {
  const { catalog, label, seatName } = state.source, { working } = state.draft, { menu, openMenu } = state.popup;
  const { startDrag, dragged } = state.drag;
  const slot = role.id, seat = getSlot(working, slot), model = seat?.model;
  const name = model ? label(model) : t('未设置');
  const summary = seat ? [seat.effort, seat.fast && t('快速'), seat.ultracode && 'Ultracode', role.fresh && t('新实例')].filter(Boolean).join(' · ') : '';
  return <button type="button" className="seats-gem" data-pick={slot} data-ultracode-on={seat?.ultracode || undefined} aria-haspopup="menu"
    aria-expanded={menu?.slot === slot && menu.kind === 'model'} title={[name, summary].filter(Boolean).join(' · ')}
    aria-label={t('{seat}：选择模型（{model}）', { seat: seatName(slot), model: [name, summary].filter(Boolean).join(' · ') })}
    onPointerDown={event => { if (model && !state.switchReason(slot, 'liveModel')) startDrag(event, model, slot); }}
    onClick={event => { if (!dragged.current || event.detail === 0) openMenu(slot, event.currentTarget); }}>
    {model && <i className="seats-mk" data-family={rowFor(catalog, model)?.family ?? agentOfModel(model)} aria-hidden="true" />}
    <span className="seats-gem-name">{name}</span><span className="seats-gem-summary">{summary}</span><CaretDown size={14} aria-hidden="true" />
  </button>;
}

function RoleActions({ state, role, library }: DialogPart & { role: TeamRole; library?: boolean }) {
  const { saving, enabled, roles } = state.draft, { edit, create, change, remove } = state.roles;
  const lock = role.locked.includes('enabled');
  const full = enabled.length >= MAX_ENABLED_ROLES, copiesFull = roles.filter(role => role.source === 'custom').length >= MAX_CUSTOM_ROLES;
  const custom = role.source === 'custom', canCopy = !custom && !role.locked.includes('copy');
  const toggleReason = lock ? t('总指挥必须保留。') : !role.enabled && full ? enabledLimit() : undefined;
  const run = (action: () => void) => { if (!library) state.popup.closeMenu(); action(); };
  const membership = (action: () => void) => run(() => {
    const panel = state.panels.dialog.current;
    (panel?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? panel)?.focus({ preventScroll: true });
    action();
  });
  const cls = library ? 'seats-btn' : 'seats-menu-item', itemRole = library ? undefined : 'menuitem';
  const reasonId = `seats-${role.id}-${library ? 'library' : 'menu'}-lock`;
  const copyReasonId = library ? 'seats-library-custom-limit' : 'seats-menu-custom-limit';
  return <div className={library ? 'seats-role-actions' : 'seats-menu-list'}>
    <button type="button" className={cls} role={itemRole} data-edit-role={role.id} disabled={saving} onClick={() => run(() => edit(role))}>{t('角色设置')}</button>
    <button type="button" className={cls} role={itemRole} data-toggle-role={role.id} disabled={saving || !!library && !!toggleReason}
      aria-disabled={!!toggleReason || undefined} aria-describedby={toggleReason ? reasonId : undefined}
      onClick={() => { if (!toggleReason) membership(() => change(role, { enabled: !role.enabled })); }}>
      {t(role.enabled ? library ? '移出团队' : '停用' : '加入团队')}
    </button>
    {toggleReason && <span id={reasonId} className="seats-role-reason" data-role-lock="membership">{toggleReason}</span>}
    {canCopy && <>
      <button type="button" className={cls} role={itemRole} disabled={saving || !!library && copiesFull}
        aria-disabled={copiesFull || undefined} aria-describedby={copiesFull ? copyReasonId : undefined}
        onClick={() => { if (!copiesFull) run(() => create(role)); }}>{t('复制后自定义')}</button>
      {role.enabled && <button type="button" className={cls} role={itemRole} data-replace-role={role.id} disabled={saving || !!library && copiesFull}
        aria-disabled={copiesFull || undefined} aria-describedby={copiesFull ? copyReasonId : undefined}
        onClick={() => { if (!copiesFull) run(() => create(role, role.id)); }}>{t('复制并替换')}</button>}
      {!library && copiesFull && <span id={copyReasonId} className="seats-role-reason">{customLimit()}</span>}
    </>}
    {custom && <button type="button" className={cls} role={itemRole} disabled={saving || !!library && lock}
      aria-disabled={lock || undefined} aria-describedby={lock ? reasonId : undefined}
      onClick={() => { if (!lock) membership(() => remove(role)); }}>{t('删除角色')}</button>}
  </div>;
}

function RoleLibrary({ state, query, setQuery, filter, setFilter }: DialogPart & {
  query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void;
}) {
  const { roles, enabled, saving } = state.draft;
  const customCount = roles.filter(role => role.source === 'custom').length;
  const search = query.trim().toLocaleLowerCase();
  const visible = roles.filter(role => (!filter || filter === 'enabled' && role.enabled || role.source === filter)
    && [roleName(role), role.id, role.duty, role.detail].some(value => value.toLocaleLowerCase().includes(search)));
  return <section className="seats-library" id="seats-library-panel" role="tabpanel" aria-labelledby="seats-library-tab">
    <div className="seats-library-tools">
      <div className="seats-library-filters" role="group" aria-label={t('筛选角色')}>
        {Object.entries({ '': '所有角色', builtin: '内置角色', library: '专业方向', custom: '自定义', enabled: '已启用' }).map(([id, title]) =>
          <button key={id} type="button" className="seats-btn" aria-pressed={filter === id} onClick={() => setFilter(id)}>{t(title)}</button>)}
      </div>
      <label className="seats-search"><input type="search" aria-label={t('搜索角色')} placeholder={t('搜索角色')}
        value={query} onChange={event => setQuery(event.target.value)} /></label>
      <span className="seats-grow" />
      <span>{t('自定义 {custom}/{limit} · 已启用 {enabled}/{total}', {
        custom: customCount, limit: MAX_CUSTOM_ROLES, enabled: enabled.length, total: MAX_ENABLED_ROLES,
      })}</span>
      <button type="button" className="seats-btn" data-new-role disabled={saving || customCount >= MAX_CUSTOM_ROLES}
        onClick={() => state.roles.create()}>{t('新建角色')}</button>
      {(enabled.length >= MAX_ENABLED_ROLES || customCount >= MAX_CUSTOM_ROLES) && <div className="seats-library-limits">
        {enabled.length >= MAX_ENABLED_ROLES && <p data-role-limit="enabled">{enabledLimit()}</p>}
        {customCount >= MAX_CUSTOM_ROLES && <p id="seats-library-custom-limit" data-role-limit="custom">{customLimit()}</p>}
      </div>}
    </div>
    <div className="seats-library-grid">{visible.map(role => {
      const duty = role.source === 'custom' ? role.duty : t(role.detail || role.duty);
      return <article className="seats-library-card" data-library-role={role.id} data-enabled={role.enabled} key={role.id}>
        <div className="seats-team-name"><RoleIcon id={role.id} /><h3 title={roleName(role)}>{roleName(role)}</h3>
          {currentLanguage() === 'zh' && ROLE_NAMES[role.id] && <span className="seats-role-english" lang="en">{ROLE_NAMES[role.id]}</span>}
          {role.source === 'custom' && <span className="seats-tag">{t('项目角色')}</span>}
          {role.enabled && <span className="seats-tag seats-library-joined">✓ {t('已加入')}</span>}
        </div>
        <p title={duty} role="group" tabIndex={0} aria-label={duty} data-role-detail>{duty}</p>
        <RoleActions state={state} role={role} library />
      </article>;
    })}</div>
    {!visible.length && <p>{t('没有匹配的角色')}</p>}
  </section>;
}

function TeamCard({ state, role, lead, changed }: DialogPart & { role: TeamRole; lead?: boolean; changed: boolean }) {
  const { over } = state.drag;
  const { menu, openMenu } = state.popup;
  const { slotState, stateMark } = seatControls(state);
  const id = role.id, mark = slotState(id), custom = role.source === 'custom';
  const duty = custom ? role.duty : t(role.detail || role.duty);
  const output = role.outputs && t('产出：{outputs}', { outputs: custom ? role.outputs : t(role.outputs) });
  const specialties = id === 'developer' ? state.draft.roles.filter(item => item.source === 'library' && item.kind === 'author').map(roleName) : [];
  const specialtyCount = specialties.length === 1 ? t('专长 1') : t('专长 {count}', { count: specialties.length });
  const specialtyNames = specialties.join(roleSeparator());
  const leadDetail = [duty, output].filter(Boolean).join(' · ');
  const classes = ['seats-team-card', lead && 'is-lead', over === id && 'is-over'].filter(Boolean).join(' ');
  const moreTitle = t('{seat}：角色操作', { seat: roleName(role) });
  return <article className={classes} data-seat={id} data-slot={id} aria-label={roleName(role)}>
    <div className="seats-team-info">
      <div className="seats-team-name"><RoleIcon id={id} />
        <h3 title={roleName(role)}>{roleName(role)}</h3>
        {currentLanguage() === 'zh' && ROLE_NAMES[id] && <span className="seats-role-english" lang="en" title={ROLE_NAMES[id]}>{ROLE_NAMES[id]}</span>}
        {specialties.length > 0 && <span className="seats-tag" title={specialtyNames} role="group" tabIndex={0}
          aria-label={`${specialtyCount} · ${specialtyNames}`} data-role-detail>{specialtyCount}</span>}
        {custom && <span className="seats-tag">{t('项目角色')}</span>}
        {lead && <span className="seats-tag seats-lead-lock" title={t('总指挥必须保留。')}><LockSimple size={14} aria-hidden="true" /></span>}
        {lead && <button type="button" className={`seats-btn seats-conductor${state.draft.config.conductor ? ' is-on' : ''}`} data-conductor
          aria-pressed={!!state.draft.config.conductor} disabled={state.draft.saving}
          onClick={() => state.draft.setConfig({ ...state.draft.config, conductor: !state.draft.config.conductor })}>
          {t(state.draft.config.conductor ? '指挥家模式：开' : '指挥家模式：关')}</button>}
        {changed && <span className="seats-chg" title={t('已改')}>●<span className="seats-sr-only">{t('已改')}</span></span>}
      </div>
      {lead
        ? <div className="seats-team-output"><p title={leadDetail} role="group" tabIndex={0} aria-label={leadDetail} data-role-detail>
          {duty}{output && <span> · {output}</span>}</p>{mark && stateMark(mark)}</div>
        : <><p title={duty} role="group" tabIndex={0} aria-label={duty} data-role-detail>{duty}</p>
          <div className="seats-team-output">{output && <p title={output} role="group" tabIndex={0} aria-label={output} data-role-detail>{output}</p>}
            {mark && stateMark(mark)}</div></>}
    </div>
    {role.fresh !== role.defaultFresh && <span className="seats-sr-only" data-fresh-override>{t(role.fresh ? '改为新实例' : '改为复用实例')}</span>}
    <SeatPicker state={state} role={role} />
    <button type="button" className="seats-btn is-icon seats-role-more" data-role-more={id}
      aria-haspopup="menu" aria-expanded={menu?.slot === id && menu.kind === 'role'} title={moreTitle} aria-label={moreTitle}
      onClick={event => openMenu(id, event.currentTarget, 'role')}><DotsThree size={20} weight="bold" aria-hidden="true" /></button>
  </article>;
}

function TeamChart({ state }: DialogPart) {
  const { info } = state.source, { enabled, working, baseline } = state.draft;
  const lead = enabled.find(role => role.id === info.lead), team = enabled.filter(role => role.id !== info.lead);
  const changed = changedSeats(enabled.map(role => role.id), working, baseline);
  return <div className="seats-chart" id="seats-team-panel" role="tabpanel" aria-labelledby="seats-team-tab">
    <div className="seats-owner" data-owner>
      <span className="seats-role-icon"><User size={18} aria-hidden="true" /></span>
      <h3>Human / Owner</h3><p>{t('目标、预算、重大决策、最终授权')}</p>
    </div>
    {lead && <><div className="seats-chart-link" aria-hidden="true" />
      <TeamCard state={state} role={lead} lead changed={changed.includes(lead.id)} /><div className="seats-chart-bus" aria-hidden="true" /></>}
    {!state.draft.config.conductor && <p className="seats-mode-note" role="status">{t('指挥家模式已关闭：总指挥自己完成所有任务，其余角色不可用。')}</p>}
    <div className={`seats-team-grid${state.draft.config.conductor ? '' : ' is-unavailable'}`} aria-disabled={!state.draft.config.conductor || undefined}>
      {team.map(role => <TeamCard key={role.id} state={state} role={role} changed={changed.includes(role.id)} />)}
      {enabled.length < MAX_ENABLED_ROLES && <button type="button" className="seats-btn seats-add-role" onClick={() => state.switchTab('library')}>
        <Plus size={16} aria-hidden="true" />{t('添加角色')}<span>{t('{count}/{limit}，从角色库选', { count: enabled.length, limit: MAX_ENABLED_ROLES })}</span>
      </button>}
    </div>
  </div>;
}

function ModelPalette({ state }: DialogPart) {
  const { catalog } = state.source, { paletteBox, paletteButton, paletteOpen, setPaletteOpen } = state.panels;
  const { startDrag, ghost } = state.drag;
  const { query, setQuery, folds, setFolds } = state.panels;
  const searching = query.trim() !== '', groups = paletteGroups(catalog, query);
  const chip = (row: SeatModel, old = false) => {
    const off = !row.available, name = modelLabel(catalog, row.model);
    const hint = off ? t('{model}（{reason}）不能放入座位', { model: name, reason: row.reason ?? '' }) : t('{model} · 拖到座位上', { model: name });
    return <span key={row.model} className={`seats-chip${old ? ' is-old' : ''}${off ? ' is-off' : ''}`}
      data-chip={row.model} data-family={row.family} aria-disabled={off || undefined} title={hint}
      onPointerDown={event => startDrag(event, row.model, null)}>
      <i className="seats-mk" data-family={row.family} /><span className="seats-chip-name">{name}</span>
      {row.listed === false && <small data-unlisted>{t('不在最新列表')}</small>}
    </span>;
  };
  const close = () => { setPaletteOpen(false); paletteButton.current?.focus(); };
  const classes = ['seats-palette', paletteOpen && 'is-open', ghost && 'is-dragging'];
  return <aside id="seats-model-tray" ref={paletteBox} className={classes.filter(Boolean).join(' ')} aria-label={t('模型盘')}>
    <header className="seats-palette-head">
      <h3>{t('模型盘')}</h3><span>{t('拖到角色上')}</span><span className="seats-grow" />
      <button type="button" className="seats-btn is-icon seats-palette-close" aria-label={t('关闭')} onClick={close}><X size={16} aria-hidden="true" /></button>
    </header>
    <label className="seats-search"><MagnifyingGlass size={16} aria-hidden="true" />
      <input type="search" data-palette-search spellCheck={false} aria-label={t('搜索模型')} placeholder={t('搜索模型')}
        value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="seats-groups">{groups.map(group => {
      const key = group.family, older = group.lines.flatMap(line => line.older);
      const open = searching || !!folds[key];
      return <section key={key} className="seats-group" data-group={key}>
        <h4><i className="seats-mk" data-family={key} />{key === 'claude' ? 'Claude' : 'Codex'} · {group.total}</h4>
        {group.lines.filter(line => line.shown.length > 0).map(line =>
          <div key={line.name} className="seats-line" data-line={line.name || 'other'}>{line.shown.map(row => chip(row))}</div>)}
        {older.length > 0 && <div className="seats-line">
          {open && older.map(row => chip(row, true))}
          {!searching && <button type="button" className="seats-fold" data-fold={key} aria-expanded={open}
            onClick={() => setFolds(previous => ({ ...previous, [key]: !open }))}>
            {open ? t('收起更早版本') : t('更早版本 ({count})', { count: older.length })}
          </button>}
        </div>}
      </section>;
    })}{!groups.length && <p className="seats-none">{t('没有匹配的模型')}</p>}</div>
  </aside>;
}

function RoutingStatus({ state }: DialogPart) {
  const { info } = state.source, { scope, dirty, count } = state.draft;
  const reviewStatus = state.review.visible && (info.routing.state === 'pending' ? '等你确认' : info.routing.state === 'invalid' ? '文件未应用' : null);
  return <span className="seats-effective" data-routing-status role="status">
    {reviewStatus ? t(reviewStatus) : dirty ? <>
      <span aria-hidden="true">●</span>{count === 1 ? t('1 处改动未保存') : t('{count} 处改动未保存', { count })}
    </> : <>
      <span aria-hidden="true">✓</span>{t(scope === 'project' ? '已保存，立即生效' : '已保存')}
      {scope === 'template' && <span>· {t('新项目从此模板创建配置')}</span>}
    </>}
  </span>;
}

function DialogHeader({ state }: DialogPart) {
  const { info } = state.source, { close } = state.panels;
  const { scope, changeScope, saving, dirty, canReset, createFile, mayOverwrite, refusal, teamError, save } = state.draft;
  const { projectId } = state.props;
  const { routing } = info;
  const switchScope = (scope: Scope) => { state.switchTab('team'); changeScope(scope); };
  const busy = saving || state.review.busy;
  const saveLabel = createFile ? '为本项目创建配置' : scope === 'template' ? '保存模板' : '保存路由';
  const createHint = t('创建 .agentrix/routing.json。');
  const projectScope = t(routing.remote ? '本项目' : '本项目 .agentrix/routing.json');
  return <header className="seats-head">
    <h2 id="seats-title">{t('模型路由')}</h2>
    <div className="seats-sources" role="group" aria-label={t('设置范围')}>
      {projectId && <button type="button" className="seats-btn" data-scope="project" aria-pressed={scope === 'project'}
        data-routing-source={scope === 'project' ? routing.layer : undefined}
        title={routing.remote ? undefined : routingLayer(routing)} disabled={busy} onClick={() => switchScope('project')}>
        {projectScope}{routing.remote && <span className="seats-scope-note">{t('SSH（本机设置）')}</span>}
      </button>}
      <button type="button" className="seats-btn" data-scope="template" aria-pressed={scope === 'template'}
        disabled={busy} onClick={() => switchScope('template')}>{t('我的默认模板')}</button>
    </div>
    <span className="seats-grow" />
    <RoutingStatus state={state} />
    <button type="button" className="seats-btn" data-reset disabled={busy || !canReset || state.review.visible}
      onClick={() => { state.popup.setMenu(null); state.draft.reset(); }}>
      <ArrowCounterClockwise size={16} aria-hidden="true" />{t('恢复默认')}
    </button>
    <div className="seats-save">
      <button type="button" className={`seats-btn${dirty && !state.review.visible ? ' is-primary' : ''}`} data-save
        disabled={(!dirty && !createFile) || !!refusal || !!teamError || busy || !mayOverwrite || state.review.visible}
        aria-describedby={createFile ? 'seats-create-hint' : undefined} onClick={() => { void save(); }}>{t(saveLabel)}</button>
      {createFile && <span id="seats-create-hint" className="seats-scope-note">{createHint}</span>}
    </div>
    <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} disabled={busy} onClick={close}><X size={16} aria-hidden="true" /></button>
  </header>;
}

function DialogToolbar({ state }: DialogPart) {
  const { info, refresh, refreshing } = state.source;
  const { nowButton, nowOpen, setNowOpen, paletteButton, paletteOpen, setPaletteOpen } = state.panels;
  const { tab, switchTab } = state;
  const { claude = null, codex = null } = info.catalogAt ?? {};
  const latest = Math.max(claude ?? 0, codex ?? 0) || null;
  const counts = { team: state.draft.enabled.length, library: state.draft.roles.length };
  return <div className="seats-toolbar">
    {!state.review.visible && <RoutingTabs tab={tab} choose={switchTab} counts={counts} />}
    <span className="seats-grow" />
    <button type="button" ref={nowButton} className="seats-btn" data-now aria-expanded={nowOpen}
      onClick={() => setNowOpen(!nowOpen)}>{t('本次对话')}<CaretDown size={16} aria-hidden="true" /></button>
    <span className="seats-age" data-catalog-at title={`Claude ${ageText(claude)} · Codex ${ageText(codex)}`}>
      {t('模型列表 {age}', { age: ageText(latest) })}
    </span>
    <button type="button" className="seats-btn is-icon" data-refresh disabled={refreshing === 'manual'}
      title={t('刷新模型列表')} aria-label={t('刷新模型列表')} onClick={() => { void refresh(); }}>
      <ArrowsClockwise size={16} aria-hidden="true" />
    </button>
    {!state.review.visible && tab !== 'library' && <button type="button" ref={paletteButton} className="seats-btn"
      data-palette-toggle aria-expanded={paletteOpen}
      aria-controls="seats-model-tray" onClick={() => setPaletteOpen(!paletteOpen)}>
      <SidebarSimple size={16} aria-hidden="true" />{t('模型盘')}
    </button>}
    {nowOpen && <ConversationChoices state={state} />}
  </div>;
}

function ConversationChoices({ state }: DialogPart) {
  const { info, label } = state.source;
  const { nowBox, setNowOpen, nowButton } = state.panels;
  const { terminalId } = state.props;
  const seatTags = info.current && info.roles.filter(role => role.enabled !== false).map(role => {
    const seat = displayedSeat(info, role.id);
    return <span key={role.id} className="seats-now" data-current-seat={role.id}>
      <b>{roleName(role)}</b>{seat ? seatSettingText(seat, label(seat.model), t('快速')) : '—'}
    </span>;
  });
  return <div ref={nowBox} className="seats-nowbox" role="region" aria-label={t('本次对话（只读）')}>
    <div className="seats-menu-head"><b>{t('本次对话（只读）')}</b>
      <button type="button" className="seats-btn is-icon" aria-label={t('关闭')} onClick={() => { setNowOpen(false); nowButton.current?.focus(); }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
    {seatTags && <div className="seats-nows">{seatTags}</div>}
    {!seatTags && <span>{terminalId ? t('这个终端还没有运行中的对话') : t('没有选定终端')}</span>}
  </div>;
}

function DialogStrip({ state }: DialogPart) {
  const { moved, label, seatName, notice, info } = state.source;
  const { count, scope, saving, refusal, discardShown, setDiscarding, teamError, stale, reload } = state.draft;
  const { keepButton } = state.panels;
  const { migration, onDismissMigration, onClose } = state.props;
  const english = currentLanguage() === 'en';
  const movedText = moved.map(({ seat, from, to }) =>
    `${seatName(seat)}${english ? ': ' : '：'}${label(from)} → ${label(to)}`).join(english ? '; ' : '；');
  return (
    <section className="seats-strip" aria-label={t('模型路由')}>
      {scope === 'project' && info.routing.notice === 'file-deleted' && <p role="status">{t('路由文件已删除。')}</p>}
      {scope === 'project' && info.routing.state === 'rejected' && <div className="seats-banner">
        <span>{t('已保留当前配置')}{info.routing.error && <> · {routingError(info.routing.error)}</>}</span>
        {(info.routing.actions.length > 0 || info.routing.raw !== undefined) &&
          <button type="button" className="seats-btn" onClick={state.review.open}>{t('查看文件')}</button>}
      </div>}
      {stale && scope === 'project' && <button type="button" className="seats-btn" data-reload-routing disabled={saving}
        onClick={() => { void reload(); }}>{t('重新载入配置')}</button>}
      {teamError && <div className="seats-banner is-bad" role="alert">{routingError(teamError)}</div>}
      {moved.length > 0 && <div className="seats-banner" role="status" data-moved><CheckCircle size={14} aria-hidden="true" />
        <span>{t('默认已更新为 {changes}', { changes: movedText })}</span></div>}
      {migration && <div className="seats-banner" role="status" data-migrated>
        <div>{migration.split('\n').map(line => <p key={line}>{migrationLine(line)}</p>)}</div>
        <button type="button" className="seats-btn" onClick={onDismissMigration}>{t('知道了')}</button>
      </div>}
      {refusal && <div className="seats-banner is-bad" role="alert"><Prohibit size={14} aria-hidden="true" /><span>{refusal.message}</span></div>}
      {discardShown && <div className="seats-banner is-warn" role="alertdialog" aria-label={t('放弃未保存的修改？')}><Warning size={14} aria-hidden="true" />
        <span> {count ? t('有 {count} 个座位的修改还没保存，关闭会丢掉它们。', { count }) :
          t('关闭会丢掉未保存的修改。')}</span>
        <button ref={keepButton} type="button" className="seats-btn" data-keep onClick={() => setDiscarding(false)}>{t('继续编辑')}</button>
        <button type="button" className="seats-btn" data-discard onClick={onClose}>{t('放弃修改')}</button></div>}
      <p className="seats-notice" role="status" aria-live="polite" data-kind={notice?.kind}>
        {notice?.kind === 'ok' && <CheckCircle size={14} aria-hidden="true" />}{notice?.text}</p>
    </section>
  );
}

function PickerSettings({ state, role }: DialogPart & { role: TeamRole }) {
  const { catalog, seatName, info } = state.source, { working, saving, config } = state.draft;
  const { edit } = state.edits;
  const slot = role.id, seat = getSlot(working, slot);
  if (!seat) return null;
  const model = rowFor(catalog, seat.model);
  const showUltracode = allowsUltracode(seat.model, role.kind === 'lead');
  const effortReason = state.switchReason(slot, 'liveEffort'), fastReason = state.switchReason(slot, 'fast'), ultraReason = state.switchReason(slot, 'ultracode');
  const ultracodeNote = showUltracode ? ultraReason ?? t('每个任务都用多代理工作流，消耗更多') : null;
  const refusal = config.conductor && role.kind === 'lead' && model?.family === 'claude' && model.fast ? info.claudeFastRefusal : undefined;
  const fastNote = fastReason ?? (!model?.fast ? t(FAST_REASONS[model?.fastReason ?? 'unsupported'])
    : refusal ? t('Claude Code 上次拒绝了快速模式，再点一次可重试') : model.family === 'claude' ? t(FAST_BILLING) : undefined);
  const toggleFast = () => {
    if (!seat.fast && refusal && !state.warnedFast.current) {
      state.warnedFast.current = true;
      state.props.onError(routingNotice({ fastError: { target: true, reason: refusal } }, t));
      return;
    }
    edit(setFast(working, slot, !seat.fast, catalog));
  };
  return <div className="seats-menu-settings">
    <div className="seats-picker-efforts" data-effort={slot} data-tile-effort={slot} role="group" aria-label={t('{seat}的推理强度', { seat: seatName(slot) })}>
      <span>{t('强度')}</span>
      {(model?.efforts ?? [seat.effort]).map(effort => <button key={effort} type="button" className="seats-btn is-small"
        data-pop-effort={effort} aria-pressed={effort === seat.effort} disabled={saving || !!effortReason} title={effortReason}
        onClick={() => edit(setEffort(working, slot, effort, catalog))}>{effort}</button>)}
    </div>
    <button type="button" className="seats-switch" role="switch" aria-checked={!!seat.fast} data-fast={slot} data-tile-fast={slot}
      disabled={saving || !!fastReason || !model?.fast && !seat.fast} aria-label={t('{seat}快速模式', { seat: seatName(slot) })} title={fastNote}
      onClick={toggleFast}>{t('快速')}<i /></button>
    {showUltracode && <button type="button" className="seats-switch" role="switch" aria-checked={!!seat.ultracode} data-ultracode={slot}
      disabled={saving || !!ultraReason} aria-describedby="seats-ultracode-note"
      onClick={() => edit({ ok: true, map: withSlot(working, slot, { ...seat, ultracode: !seat.ultracode }) })}>Ultracode<i /></button>}
    {role.kind !== 'lead' && <button type="button" className="seats-switch" role="switch" aria-checked={role.fresh} data-fresh={slot}
      disabled={saving} onClick={() => state.roles.change(role, { fresh: !role.fresh })}>{t('新实例')}<i /></button>}
    {effortReason && effortReason !== fastNote && effortReason !== ultracodeNote && <small className="seats-menu-note">{effortReason}</small>}
    {fastNote && fastNote !== ultracodeNote && <small className="seats-menu-note" data-fast-note>{fastNote}</small>}
    {ultracodeNote && <small className="seats-menu-note" id="seats-ultracode-note">{ultracodeNote}</small>}
  </div>;
}

function TeamModelOptions({ state, selected, pick, unavailable }: DialogPart & { selected?: string; pick: (model: string) => void; unavailable?: string }) {
  const { catalog } = state.source, { modelFolds, setModelFolds } = state.popup;
  return paletteGroups(catalog).filter(group => group.lines.length > 0).map(({ family, lines }) => {
    const current = lines.flatMap(line => [...line.shown, ...line.older.filter(row => row.model === selected)]);
    const older = lines.flatMap(line => line.older.filter(row => row.model !== selected));
    const open = !!modelFolds[family];
    return <div key={family} className="seats-picker-family" role="group" aria-label={family === 'claude' ? 'Claude' : 'Codex'}>
      <span aria-hidden="true">{family === 'claude' ? 'Claude' : 'Codex'}</span>
      {modelMenuItems(current, selected, pick, unavailable)}
      {older.length > 0 && <>
        <button type="button" className="seats-menu-item seats-menu-fold" role="menuitem" data-picker-fold={family} aria-expanded={open}
          onClick={() => setModelFolds(previous => ({ ...previous, [family]: !open }))}>
          {open ? t('收起更早版本') : t('更早版本 ({count})', { count: older.length })}
        </button>
        {open && modelMenuItems(older, selected, pick, unavailable)}
      </>}
    </div>;
  });
}

function DialogMenu({ state }: DialogPart) {
  const { menu, menuBox, custom, setCustom, closeMenu, menuKeys } = state.popup;
  const { seatName } = state.source;
  const { assign, submitCustom } = state.edits;
  if (!menu) return null;
  const pick = (slot: SlotId, model: string) => { assign(slot, model); closeMenu(); };
  const role = state.draft.enabled.find(item => item.id === menu.slot);
  const selected = getSlot(state.draft.working, menu.slot)?.model;
  const modelReason = state.switchReason(menu.slot, 'liveModel');
  const menuStyle = { left: menu.left, top: menu.top, bottom: menu.bottom, width: menu.width, maxHeight: menu.maxHeight };
  return <>
  {menu.kind === 'role' && role && <div ref={menuBox} className="seats-menu is-role" role="menu"
    aria-label={t('{seat}：角色操作', { seat: seatName(menu.slot) })} style={menuStyle} onKeyDown={menuKeys}>
    <MenuHeader title={seatName(menu.slot)} close={closeMenu} />
    <RoleActions state={state} role={role} />
  </div>}
  {menu.kind === 'model' && <div key={menu.slot} ref={menuBox} className="seats-menu" data-model-picker-menu style={menuStyle}>
    <MenuHeader title={t('{seat}：选择模型', { seat: seatName(menu.slot) })} close={closeMenu} />
    {modelReason && <small className="seats-menu-note" role="status">{modelReason}</small>}
    <div className="seats-menu-list seats-model-list" role="menu"
      aria-label={t('{seat}：选择模型', { seat: seatName(menu.slot) })} onKeyDown={menuKeys}>
    <TeamModelOptions state={state} selected={selected} pick={model => pick(menu.slot, model)} unavailable={modelReason} />
    {!custom && <button type="button" role="menuitem" className="seats-menu-item" data-custom disabled={!!modelReason}
      title={modelReason} onClick={() => setCustom({ text: '', error: '' })}>{t('其他模型…')}</button>}
    </div>
    {custom && <div className="seats-menu-custom">
      <input type="text" data-custom-input maxLength={160} autoFocus spellCheck={false} aria-label={t('模型名')} placeholder={t('模型名，例如 gpt-6.3-sol')} value={custom.text} disabled={!!modelReason}
        onChange={event => setCustom({ text: event.target.value, error: '' })}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          submitCustom(menu.slot);
        }} />
      <button type="button" className="seats-btn is-small" data-custom-apply disabled={!!modelReason} onClick={() => submitCustom(menu.slot)}>{t('使用')}</button>
      {custom.error && <small className="seats-menu-error" role="alert" data-custom-error>{custom.error}</small>}
    </div>}
    {role && <PickerSettings state={state} role={role} />}
  </div>}
  </>;
}

export function SeatsDialog(props: SeatsDialogProps) {
  const state = useDialogState(props);
  const { catalog, label } = state.source, { working } = state.draft;
  const { dialog, nowOpen, paletteOpen, close } = state.panels, { menu } = state.popup;
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('');
  const { editor } = state.roles, { review } = state;
  const { ghost } = state.drag, { tab, keys } = state;
  return createPortal(
    <div className="seats-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !menu && !nowOpen && !paletteOpen && !editor && !review.busy) close(); }}>
      <div ref={dialog} className="seats-dialog" role="dialog" aria-modal="true" aria-labelledby="seats-title" tabIndex={-1} onKeyDown={keys}>
        <div className="seats-dialog-content" inert={!!editor}>
        <DialogHeader state={state} />
        <DialogToolbar state={state} />
        <div className="seats-body">
          <DialogStrip state={state} />
          {review.visible ? <RoutingReview source={state.source.info.routing} roles={state.source.info.roles}
            busy={review.busy} refreshed={review.refreshed} act={review.act}
            close={state.source.info.routing.state === 'rejected' ? review.close : undefined} rawOpen={review.raw} toggleRaw={review.toggle} /> : <>
          <div className="seats-work">
            {tab === 'library'
              ? <RoleLibrary state={state} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} /> : <TeamChart state={state} />}
            {tab !== 'library' && <ModelPalette state={state} />}
          </div></>}
        </div>
        {!review.visible && <DialogMenu state={state} />}
        {ghost && <span className="seats-ghost" style={{ left: ghost.x, top: ghost.y }} data-family={modelRow(catalog, ghost.model)?.family}>
          <i className="seats-mk" data-family={modelRow(catalog, ghost.model)?.family ?? agentOfModel(ghost.model)} />{label(ghost.model)}
        </span>}
        </div>
        {editor && <RoleEditor key={JSON.stringify([editor.id, !!editor.existing])} {...editor} roles={state.draft.roles} taken={state.roles.taken}
          catalog={catalog} models={working} close={state.roles.close} save={state.roles.save} copy={state.roles.create} />}
      </div>
    </div>, document.body);
}
