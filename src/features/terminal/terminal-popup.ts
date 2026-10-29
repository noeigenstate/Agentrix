import type { Terminal } from '@xterm/xterm';
import { fitTerminal } from './terminal-fit.ts';

type Entry = { terminal: Terminal; restore?: () => void };
const terminals = new Map<string, Entry>();
const keyFor = (id: string, sessionId: string | null) => JSON.stringify([id, sessionId]);

export function registerReadingTerminal(id: string, sessionId: string, terminal: Terminal) {
  const key = keyFor(id, sessionId), entry: Entry = { terminal };
  terminals.get(key)?.restore?.();
  terminals.set(key, entry);
  return () => { entry.restore?.(); if (terminals.get(key) === entry) terminals.delete(key); };
}

export function pruneReadingCli(liveKeys: ReadonlySet<string>) {
  for (const [key, entry] of terminals) {
    if (liveKeys.has(key)) continue;
    entry.restore?.(); terminals.delete(key);
  }
}

// Move only xterm's DOM. React keeps its original host, and the PTY, renderer and handlers stay attached.
export function mountReadingTerminal(id: string, sessionId: string | null, host: HTMLElement) {
  const entry = terminals.get(keyFor(id, sessionId)), terminal = entry?.terminal, element = terminal?.element;
  if (!entry || !terminal || !element) throw new Error('Terminal is not ready');
  entry.restore?.();
  const parent = element.parentElement;
  if (!parent) throw new Error('Terminal is not ready');
  const next = element.nextSibling;
  const fit = () => { fitTerminal(terminal); terminal.refresh(0, terminal.rows - 1); };
  const observer = new ResizeObserver(fit);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; observer.disconnect();
    if (element.contains(document.activeElement)) terminal.blur();
    parent.insertBefore(element, next);
    fit(); entry.restore = undefined;
  };
  entry.restore = restore;
  try { host.appendChild(element); fit(); terminal.focus(); observer.observe(host); }
  catch (error) { restore(); throw error; }
  return restore;
}
