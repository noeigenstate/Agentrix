import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { registerReadingTerminal } from './terminal-popup';
import type { ScreenAgent } from '../cli-screens/index.ts';
import { fitTerminal } from './terminal-fit';
import type { TerminalPacket } from '../../shared/types';
import { createTerminalLinkProvider } from './terminal-links';
import { styleTerminal } from './terminal-styling';
import { terminalOptions, terminalTheme } from './terminal-theme';
import { gpuRenderer, setTerminalWeight, terminalRenderer, useTerminalRenderer } from './terminal-renderer';
import { terminalFontFamily } from './terminal-font';
import { receiveScreenPaste, registerScreen, setQueueCount, setScreenAgent, writeScreen } from './terminal-screen';
import '@xterm/xterm/css/xterm.css';
import { t } from '../../shared/i18n';
import { commandShortcut, isMac, isWindows } from '../../shared/platform';

// The terminal text weight chosen in Settings, which App writes on the document; 400 when none is chosen.
const chosenWeight = () => Number(document.documentElement.dataset.terminalWeight) || Number(terminalOptions.fontWeight);

export function TerminalPane({ id, sessionId, agent = null, agentActive = !!agent, agentStartedAt, installedVersion, queue = 0, fontSize,
  onError, focused, onOpenLink, remote = false }: {
  id: string; sessionId: string | null; agent?: ScreenAgent | null; agentActive?: boolean; agentStartedAt?: number | null; installedVersion?: string | null;
  queue?: number; fontSize: number; focused: boolean; onError: (message: string) => void;
  onOpenLink: (id: string, target: string) => void;
  remote?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState(false);
  const clipboardNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gpu = useRef<ReturnType<typeof gpuRenderer> | null>(null);
  const renderer = useTerminalRenderer();
  const menuRef = useRef<HTMLDivElement>(null);
  const report = useRef(onError);
  report.current = onError;
  const currentAgent = useRef(agent); currentAgent.current = agent;
  const activeAgent = useRef(agentActive); activeAgent.current = agentActive;
  const openLink = useRef(onOpenLink);
  openLink.current = onOpenLink;
  // Read-only: the screen registry learns which agent runs here and how many messages main holds queued for it.
  useEffect(() => { setScreenAgent(id, agent, { active: agentActive, startedAt: agentStartedAt, installedVersion }); },
    [id, agent, agentActive, agentStartedAt, installedVersion]);
  useEffect(() => { setQueueCount(id, queue); }, [id, queue]);
  useEffect(() => () => { setQueueCount(id, 0); setScreenAgent(id, null); }, [id]);
  const copy = async (text: string) => { const result = await window.agentrix.copy(text); if (!result.ok) report.current(result.error); };
  const paste = async () => {
    const terminal = term.current;
    const result = await window.agentrix.readClipboard();
    if (!result.ok) { report.current(result.error); return; }
    if (terminal && terminal === term.current && result.value) { terminal.paste(result.value); return; }
    // Over SSH the CLI cannot reach this computer's clipboard for a picture: it goes over as a file on that computer,
    // and its path is pasted instead, which Codex and Claude Code both take as an attached picture.
    if (!remote) return;
    const image = await window.agentrix.clipboardImage(id);
    if (!image.ok) { report.current(image.error); return; }
    if (terminal && terminal === term.current && image.value) terminal.paste(image.value + ' ');
  };
  const copyAll = () => {
    const terminal = term.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const rows: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      // Keep spaces at a soft wrap; trimming every visual row changes commands.
      const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
      if (line.isWrapped && rows.length) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    void copy(rows.join('\n').trimEnd());
  };
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenu(null); term.current?.focus(); } };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [menu]);

  useEffect(() => {
    if (!host.current || !sessionId) return;
    const activateLink = (event: MouseEvent, target: string) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.button !== 0) return;
      // xterm activates links on mouseup. Let that event reach its document
      // selection listener so opening a preview cannot leave a drag running.
      event.preventDefault();
      openLink.current(id, target);
    };
    const hoverLink = (_event: MouseEvent, target: string) => { if (host.current) host.current.title = `${isMac ? t('⌘ + 点按打开链接') : t('Ctrl + 鼠标左键打开链接')}\n${target}`; };
    const leaveLink = () => { if (host.current) host.current.removeAttribute('title'); };
    const terminal = new Terminal({
      fontFamily: document.documentElement.dataset.terminalFontFamily || terminalFontFamily(),
      fontSize, lineHeight: 1.3, ...terminalOptions, scrollback: 3000,
      cursorBlink: true, cursorStyle: 'bar',
      // Decorations (the heading and bullet styling) are still an experimental part of xterm's API.
      allowProposedApi: true, allowTransparency: true,
      // Bundled ConPTY reflows the prompt on resize; the cursor line must follow
      // that reflow too, or later output can overwrite old prompt characters.
      reflowCursorLine: !remote,
      linkHandler: { activate: (event, target) => { if (/^(?:https?|file):\/\//i.test(target)) activateLink(event, target); },
        hover: hoverLink, leave: leaveLink, allowNonHttpProtocols: true },
      theme: terminalTheme(),
    });
    terminal.open(host.current);
    setClipboardNotice(false);
    setTerminalWeight(terminal, chosenWeight());
    gpu.current = gpuRenderer(terminal); gpu.current.set(terminalRenderer() === 'gpu');
    // node-pty uses its bundled modern ConPTY, including on Windows 10.
    // 21376 is xterm's capability threshold for VT wrapping and reflow.
    if (!remote && isWindows) terminal.options.windowsPty = { backend: 'conpty', buildNumber: 21376 };
    const links = terminal.registerLinkProvider(createTerminalLinkProvider(terminal, activateLink, hoverLink, leaveLink));
    let clipboardGesture = -Infinity;
    const rememberGesture = (event: Event) => { if (event.isTrusted) clipboardGesture = performance.now(); };
    const clipboardWrites = terminal.parser.registerOscHandler(52, data => {
      const separator = data.indexOf(';'), payload = data.slice(separator + 1);
      if (remote || !currentAgent.current || !activeAgent.current || separator < 0 || !payload || payload === '?'
        || payload.length > 4 * Math.ceil(64 * 1024 / 3) || performance.now() - clipboardGesture > 3000) return true;
      try {
        const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0));
        if (bytes.length > 64 * 1024) return true;
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        clipboardGesture = -Infinity;
        void window.agentrix.copy(text).then(result => {
          if (disposed) return;
          if (!result.ok) { report.current(result.error); return; }
          setClipboardNotice(true);
          clearTimeout(clipboardNoticeTimer.current);
          clipboardNoticeTimer.current = setTimeout(() => setClipboardNotice(false), 3000);
        }, error => { if (!disposed) report.current(String(error)); });
      } catch { /* Ignore invalid clipboard payloads. */ }
      return true;
    });
    terminal.element?.addEventListener('pointerdown', rememberGesture, true);
    terminal.element?.addEventListener('keydown', rememberGesture, true);
    const styling = styleTerminal(terminal);
    const fontObserver = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'data-terminal-weight')) setTerminalWeight(terminal, chosenWeight());
      if (records.some(record => record.attributeName === 'data-terminal-font-family')) {
        terminal.options.fontFamily = document.documentElement.dataset.terminalFontFamily || terminal.options.fontFamily;
        requestAnimationFrame(() => { if (term.current === terminal && host.current?.clientWidth) fitTerminal(terminal); });
      }
    });
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-terminal-weight', 'data-terminal-font-family'] });
    term.current = terminal;
    const unregister = registerScreen(id, terminal, sessionId);
    const unregisterPopup = registerReadingTerminal(id, sessionId, terminal);
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180)), selection: terminal.getSelection() });
    };
    // xterm moves into the reading popup; its menu must follow its DOM rather than React's original host.
    terminal.element?.addEventListener('contextmenu', contextMenu);
    let disposed = false;
    let ready = false;
    let lastSeq = 0;
    let queued: TerminalPacket[] = [];
    const apply = (packet: TerminalPacket) => {
      if (packet.sessionId !== sessionId || packet.seq <= lastSeq) return;
      lastSeq = packet.seq;
      writeScreen(id, packet.data, packet.approval);
    };
    const unsubscribe = window.agentrix.onTerminalData(packet => {
      if (packet.id !== id || packet.sessionId !== sessionId || disposed) return;
      if (!ready) queued.push(packet); else apply(packet);
    });
    // Subscribe before obtaining the snapshot. Sequence numbers prevent gaps
    // and double output when the terminal is mounted during an active stream.
    window.agentrix.attachTerminal(id).then(result => {
      if (disposed) return;
      if (!result.ok) { queued = []; unsubscribe(); report.current(result.error); return; }
      if (result.value.sessionId === sessionId) {
        writeScreen(id, result.value.data, result.value.approval);
        lastSeq = result.value.seq;
      }
      ready = true;
      for (const packet of queued) apply(packet);
      queued = [];
    }).catch(error => { if (!disposed) { queued = []; unsubscribe(); report.current(String(error)); } });
    const input = terminal.onData(data => window.agentrix.writeTerminal(id, data));
    // Messages from the reading view and dictation. Where the program would take a pasted line break as Enter, the
    // main process names the key that starts a new line instead, and the text is typed with it.
    const offPaste = window.agentrix.onTerminalPaste(packet => {
      if (disposed || packet.id !== id || packet.sessionId !== sessionId) return;
      receiveScreenPaste(id, sessionId, packet.text, () => disposed ? null : currentAgent.current, () => {
        if (packet.lineBreak) terminal.input(packet.text.replace(/\r\n?|\n/g, packet.lineBreak), true);
        else terminal.paste(packet.text);
      });
    });
    const selection = terminal.onSelectionChange(() => { if (host.current) host.current.dataset.hasSelection = String(terminal.hasSelection()); });
    const resized = terminal.onResize(({ cols, rows }) => window.agentrix.resizeTerminal(id, cols, rows));
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true;
      if (!event.isComposing && event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        // xterm's legacy Enter mapping drops Shift. ConPTY needs native key
        // records; Linux and macOS TUIs understand the modified Enter CSI-u sequence.
        window.agentrix.writeTerminal(id, remote || !isWindows ? '\x1b[13;2u' : '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_');
        return false;
      }
      // macOS: ⌘C copies, ⌘V pastes and ⌘A selects all; Control keys all go to the program (Control+C interrupts).
      const commandKey = isMac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && !event.altKey;
      const copyKey = commandKey && event.code === 'KeyC' && (isMac || event.shiftKey || terminal.hasSelection());
      const pasteKey = (commandKey && event.code === 'KeyV') || (!isMac && event.shiftKey && event.code === 'Insert');
      const selectKey = event.code === 'KeyA' && (isMac ? commandKey : event.ctrlKey && event.shiftKey);
      // Ctrl+C without a selection still interrupts the command.
      if (!copyKey && !pasteKey && !selectKey) return true;
      event.preventDefault();
      if (copyKey) {
        const selection = terminal.getSelection();
        if (selection) void copy(selection);
      } else if (pasteKey) void paste();
      else terminal.selectAll();
      return false;
    });
    const focusIn = () => window.agentrix.terminalFocus(id, true);
    const focusOut = () => window.agentrix.terminalFocus(id, false);
    terminal.textarea?.addEventListener('focus', focusIn);
    terminal.textarea?.addEventListener('blur', focusOut);
    const resize = () => {
      if (!disposed && host.current && host.current.clientWidth > 20 && host.current.clientHeight > 20) {
        try { fitTerminal(terminal); } catch { /* A hidden panel will be fitted when shown. */ }
      }
    };
    // Transitions change the size every frame. xterm and ConPTY each reflow long lines on resize, and
    // a shrink-then-grow that nets out to the same size leaves ConPTY untouched while xterm has
    // reflowed twice; later output then lands beside stale characters. Both sides therefore reflow
    // once, at the settled size. data-fit-pending marks the short window before that happens.
    let settle = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(settle); host.current?.setAttribute('data-fit-pending', '');
      settle = window.setTimeout(() => { host.current?.removeAttribute('data-fit-pending'); resize(); }, 80);
    });
    observer.observe(host.current);
    const frame = requestAnimationFrame(resize);
    return () => {
      disposed = true; queued = [];
      clearTimeout(clipboardNoticeTimer.current);
      unsubscribe(); offPaste(); input.dispose(); selection.dispose(); resized.dispose(); links.dispose(); clipboardWrites.dispose(); styling.dispose(); fontObserver.disconnect(); observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(settle);
      terminal.textarea?.removeEventListener('focus', focusIn); terminal.textarea?.removeEventListener('blur', focusOut); focusOut();
      terminal.element?.removeEventListener('contextmenu', contextMenu);
      terminal.element?.removeEventListener('pointerdown', rememberGesture, true);
      terminal.element?.removeEventListener('keydown', rememberGesture, true); unregisterPopup();
      gpu.current?.dispose(); gpu.current = null; unregister();
      terminal.dispose(); term.current = null;
    };
  }, [id, sessionId]);

  // The GPU renderer, unless the compatible one is chosen in Settings.
  useEffect(() => { gpu.current?.set(renderer === 'gpu'); }, [renderer]);

  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    if (host.current?.clientWidth) fitTerminal(terminal);
  }, [fontSize]);
  useEffect(() => {
    if (focused && sessionId) {
      const frame = requestAnimationFrame(() => {
        if (!term.current) return;
        // ResizeObserver fits after reveal settles; fitting while xterm is still paused can leave its viewport a row behind.
        // Selecting a split through its controls must leave the keyboard on that control.
        if (!host.current?.closest('.terminal-split')?.contains(document.activeElement)) term.current.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [focused, sessionId]);
  const action = (callback: () => void) => { callback(); setMenu(null); term.current?.focus(); };
  return <><div className="terminal-host" ref={host} aria-label={t('项目终端')} />
    {clipboardNotice && createPortal(<div className="notice-toast" role="status">{t('终端已将文字复制到剪贴板')}</div>, document.body)}
    {menu && createPortal(<div ref={menuRef} className="dropdown terminal-context-menu" role="menu" aria-label={t('终端操作')} style={{ left: menu.x, top: menu.y }}>
    <button role="menuitem" disabled={!menu.selection} onClick={() => action(() => { void copy(menu.selection); })}>{t('复制')}<span>{commandShortcut('C')}</span></button>
    <button role="menuitem" onClick={() => action(copyAll)}>{t('复制全部终端文字')}</button>
    <button role="menuitem" onClick={() => action(() => term.current?.selectAll())}>{t('全选')}<span>{commandShortcut(isMac ? 'A' : 'Shift+A')}</span></button>
    <div className="menu-divider" />
    <button role="menuitem" onClick={() => action(() => { void paste(); })}>{t('粘贴')}<span>{commandShortcut('V')}</span></button>
  </div>, document.body)}</>;
}
