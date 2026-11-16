// A dispatched worker's own terminal, shown in its split while the worker waits for the owner (feed.awaiting === 'owner'). The owner answers the
// worker's question here: the keys go to this worker's terminal only (never the planner's), tagged with the epoch of the PTY they were typed for;
// main drops them unless that PTY is live and the worker still awaits the owner. The view is mounted while the worker waits and goes with it.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { fitTerminal } from '../terminal/terminal-fit';
import { terminalFontFamily } from '../terminal/terminal-font';
import { terminalOptions, terminalTheme } from '../terminal/terminal-theme';
import { isMac, isWindows } from '../../shared/platform';
import { t } from '../../shared/i18n';
import '@xterm/xterm/css/xterm.css';

// 12px on an 18px line, as the mockup draws the worker's terminal.
const FONT_SIZE = 12, LINE_HEIGHT = 1.5;
const visible = (node: HTMLElement) => node.clientWidth > 20 && node.clientHeight > 20;

export function WorkerTerminal({ terminalId, callId, name, onError, onUnavailable }: {
  terminalId: string; callId: string; name: string; onError(message: string): void; onUnavailable(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const report = useRef(onError), gone = useRef(onUnavailable);
  report.current = onError; gone.current = onUnavailable;

  useEffect(() => {
    const node = host.current, bridge = window.agentrix;
    if (!node || typeof bridge.attachWorkerTerminal !== 'function' || typeof bridge.onWorkerTerminalData !== 'function') { gone.current(); return; }
    let disposed = false, epoch: string | null = null, exited = false, lastSeq = 0, quiet = false, attached = false;
    let queued: { epoch?: string; seq?: number; data?: string; exited?: boolean }[] = [];
    const terminal = new Terminal({
      fontFamily: document.documentElement.dataset.terminalFontFamily || terminalFontFamily(),
      fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, ...terminalOptions, scrollback: 3000, cursorBlink: true, cursorStyle: 'bar',
      allowTransparency: true, theme: terminalTheme(),
    });
    terminal.open(node);
    if (isWindows) terminal.options.windowsPty = { backend: 'conpty', buildNumber: 21376 };
    const fit = () => { if (!disposed && visible(node)) { try { fitTerminal(terminal); } catch { /* Laid out later. */ } } };
    const live = () => epoch !== null && !exited && !disposed;

    // A packet of the PTY this view shows, in order. One of another PTY means the worker started over: the snapshot is read again, once for each epoch seen,
    // so a stream the main process keeps sending can never loop this view.
    const tried = new Set<string>();
    const apply = (packet: { epoch?: string; seq?: number; data?: string; exited?: boolean }) => {
      if (packet.epoch !== epoch) {
        if (packet.epoch && !tried.has(packet.epoch)) { tried.add(packet.epoch); attached = false; queued = [packet]; void load(); }
        return;
      }
      if (packet.exited) { exited = true; return; }
      if (typeof packet.seq !== 'number' || packet.seq <= lastSeq) return;
      lastSeq = packet.seq;
      if (packet.data) terminal.write(packet.data);
    };
    const off = bridge.onWorkerTerminalData(packet => {
      if (disposed || packet.terminalId !== terminalId || packet.callId !== callId) return;
      if (!attached) queued.push(packet); else apply(packet);
    });
    const input = terminal.onData(data => { if (live()) bridge.workerTerminalKeys(terminalId, callId, epoch!, data); });
    // Only a view that is laid out has a size to tell the worker; a hidden or zero-sized one never resizes the PTY.
    const resized = terminal.onResize(({ cols, rows }) => { if (!quiet && live() && visible(node)) bridge.resizeWorkerTerminal(terminalId, callId, epoch!, cols, rows); });
    // Copy is explicit: with a selection (Ctrl+C, Ctrl+Shift+C, ⌘C). Without one, Ctrl+C reaches the CLI. Paste is xterm's own paste event; the clipboard is never read here.
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || event.isComposing) return true;
      const copyKey = isMac ? event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyC'
        : event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyC' && (event.shiftKey || terminal.hasSelection());
      if (copyKey) {
        event.preventDefault();
        const selection = terminal.getSelection();
        if (selection) void bridge.copy(selection).then(result => { if (!result.ok) report.current(result.error); }, error => report.current(String(error)));
        return false;
      }
      const pasteKey = (isMac ? event.metaKey : event.ctrlKey && !event.altKey) && event.code === 'KeyV' || (!isMac && event.shiftKey && event.code === 'Insert');
      return !pasteKey;
    });
    const observer = new ResizeObserver(fit);
    observer.observe(node);

    // Subscribed before the snapshot is read: the queue and the sequence numbers leave no gap and no repeat. The answer is main's envelope: an error, no terminal (null), or the snapshot.
    const load = () => Promise.resolve(bridge.attachWorkerTerminal(terminalId, callId)).then(result => {
      if (disposed) return;
      if (!result.ok) { queued = []; report.current(result.error); gone.current(); return; }
      const snapshot = result.value;
      if (!snapshot) { queued = []; gone.current(); return; }
      exited = snapshot.exited;
      // The same PTY again changes nothing on the screen; a new one starts it over.
      if (snapshot.epoch !== epoch) {
        if (epoch !== null) terminal.reset();
        epoch = snapshot.epoch; lastSeq = snapshot.seq;
        quiet = true; try { terminal.resize(Math.max(2, snapshot.cols), Math.max(2, snapshot.rows)); } finally { quiet = false; }
        if (snapshot.data) terminal.write(snapshot.data);
      }
      attached = true;
      const pending = queued; queued = [];
      for (const packet of pending) apply(packet);
      fit();
    }).catch(error => { if (!disposed) { queued = []; report.current(String(error)); gone.current(); } });
    void load();

    return () => {
      disposed = true; queued = [];
      off(); input.dispose(); resized.dispose(); observer.disconnect();
      terminal.dispose();
      bridge.detachWorkerTerminal?.(terminalId, callId);
    };
  }, [terminalId, callId]);

  // Typing, selecting and copying here expands nothing; Escape is the CLI's own key. Mouse-up is left alone: xterm ends a drag selection on the document.
  const keep = (event: { stopPropagation(): void }) => event.stopPropagation();
  return <div className="subagent-worker-term" aria-label={t('{name} 的终端', { name })} onKeyDown={keep} onKeyUp={keep} onPointerDown={keep} onMouseDown={keep} onClick={keep} onDoubleClick={keep} onContextMenu={keep}>
    <div className="subagent-worker-host" ref={host} />
  </div>;
}
