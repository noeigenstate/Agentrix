import './Select.css';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown } from '@phosphor-icons/react';

export interface SelectOption { value: string; label: ReactNode; disabled?: boolean }

const MENU_GAP = 4, EDGE = 8, MAX_HEIGHT = 280, MAX_WIDTH = 360;

export function selectMenuWidths(triggerWidth: number, windowWidth: number) {
  const maxWidth = Math.min(Math.max(triggerWidth, MAX_WIDTH), Math.max(0, windowWidth - EDGE * 2));
  return { minWidth: Math.min(triggerWidth, maxWidth), maxWidth };
}

export function selectMenuLeft(triggerLeft: number, menuWidth: number, windowWidth: number) {
  return Math.max(EDGE, Math.min(triggerLeft, windowWidth - menuWidth - EDGE));
}

// A listbox in place of the native <select>, whose pop-up the system draws (its width, corners, shadow and blue highlight are not ours).
// The menu fits its options with the trigger as its minimum width, and flips upward when the window has no room below.
export function Select({ value, options, onChange, label, className = '', disabled = false, icon }: {
  value: string; options: SelectOption[]; onChange: (value: string) => void; label: string; className?: string; disabled?: boolean; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; minWidth: number; maxWidth: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLUListElement>(null), typed = useRef({ text: '', at: 0 });
  const id = useId();
  const selected = options.findIndex(option => option.value === value);
  // A dialog is in the top layer: the menu must live inside it to be seen.
  const host = trigger.current?.closest('dialog') ?? document.body;

  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  const openMenu = () => { setActive(Math.max(0, options.findIndex(option => option.value === value && !option.disabled))); setOpen(true); };
  const choose = (index: number) => { const option = options[index]; if (!option || option.disabled) return; if (option.value !== value) onChange(option.value); close(true); };
  const step = (from: number, delta: number) => {
    for (let at = from + delta; at >= 0 && at < options.length; at += delta) if (!options[at].disabled) return at;
    return from;
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const box = trigger.current.getBoundingClientRect(), list = menu.current;
    const widths = selectMenuWidths(box.width, innerWidth);
    const room = { below: innerHeight - box.bottom - EDGE - MENU_GAP, above: box.top - EDGE - MENU_GAP };
    const wanted = Math.min(MAX_HEIGHT, list.scrollHeight + 2);
    const up = room.below < wanted && room.above > room.below;
    const maxHeight = Math.min(MAX_HEIGHT, Math.max(96, up ? room.above : room.below));
    // Apply the constraints before measuring, including any space used by the vertical scrollbar.
    Object.assign(list.style, { minWidth: `${widths.minWidth}px`, maxWidth: `${widths.maxWidth}px`, maxHeight: `${maxHeight}px` });
    setPlace({ ...widths, left: selectMenuLeft(box.left, list.getBoundingClientRect().width, innerWidth), maxHeight,
      ...(up ? { bottom: innerHeight - box.top + MENU_GAP } : { top: box.bottom + MENU_GAP }) });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false); };
    const away = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    addEventListener('resize', away); addEventListener('blur', away);
    return () => { document.removeEventListener('pointerdown', outside, true); removeEventListener('resize', away); removeEventListener('blur', away); };
  }, [open]);

  useEffect(() => { if (open) menu.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [open, active, place]);

  const typeAhead = (key: string) => {
    const now = Date.now(), text = (now - typed.current.at > 700 ? '' : typed.current.text) + key.toLowerCase();
    typed.current = { text, at: now };
    const hit = options.findIndex(option => !option.disabled && (typeof option.label === 'string' ? option.label : option.value).toLowerCase().startsWith(text));
    if (hit >= 0) setActive(hit);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openMenu(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(at => step(at, event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setActive(event.key === 'Home' ? step(-1, 1) : step(options.length, -1)); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); }
    else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) typeAhead(event.key);
  };

  return <>
    <button type="button" ref={trigger} className={`select-trigger ${className}`} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      disabled={disabled} data-value={value} onClick={() => open ? close(false) : openMenu()} onKeyDown={onKeyDown}>
      {icon}<span className="select-value">{options[selected]?.label ?? ''}</span><CaretDown size={12} aria-hidden="true" />
    </button>
    {open && createPortal(<ul ref={menu} id={id} role="listbox" aria-label={label} className="select-menu"
      style={{ left: place?.left, width: 'max-content', minWidth: place?.minWidth, maxWidth: place?.maxWidth, top: place?.top, bottom: place?.bottom, maxHeight: place?.maxHeight, visibility: place ? undefined : 'hidden' }}>
      {options.map((option, index) => <li key={option.value} role="option" aria-selected={index === selected} aria-disabled={option.disabled || undefined} data-value={option.value} data-active={index === active} title={typeof option.label === 'string' ? option.label : undefined}
        onPointerEnter={() => !option.disabled && setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</span></li>)}
    </ul>, host)}
  </>;
}
