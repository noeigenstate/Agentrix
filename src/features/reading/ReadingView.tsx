import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowDown, Image as ImageIcon, PaperPlaneRight, Stop } from '@phosphor-icons/react';
import type { AgentCommand, ProjectTerminal } from '../../shared/types';
import { actionText } from '../agents/action-text';
import { dictateInto } from '../voice/voice-input';
import { createDictationSend } from './dictation-send';
import { bindApproval, useScreen } from '../terminal/terminal-screen';
import { parseAgentScreen } from '../agents/agent-screen';
import { cliDialogShown, hasCliInput, isAtPrompt, isCliWorking } from './cli-panel';
import { cliReady, DIALOG_SETTLE, endDialog, rememberReady, startDialog } from './reading-ready';
import { WaitingCard } from './WaitingCard';
import { ReadingWelcome } from './ReadingWelcome';
import { typeReadingCommand } from './reading-command';
import { dataUrl, thumbnail } from '../../shared/image-thumbnail';
import { useNativePictures } from './useNativePictures';
import { rememberPicture } from './pasted-pictures';
import { useWelcomeStarting } from './reading-welcome';
import { ReadingTerminalPopup } from './ReadingTerminalPopup';
import { setChoiceVisible } from './reading-mode';
import { hasEditingFocus, isTyping, markTyping } from './typing';
import { useStickToBottom } from './useStickToBottom';
import { useReadingHistory } from './useReadingConversation';
import { blocks, useVisibleTail } from './useVisibleTail';
import './reading.css';
import './reading-flow.css';
import { t } from '../../shared/i18n';
import { useFittingHint } from '../../shared/useFittingHint';
import { useMentions } from './useMentions';
import { MentionPalette } from './MentionPalette';
import { isTypedCommand, pendingPromptCards, sameMessage, type PendingPrompt } from './pending-prompts';
import { usePendingPrompts } from './usePendingPrompts';
import { PendingPromptEntries, UserImages } from './PendingPromptEntries';
import { AgentMark, TimelineStep } from './Timeline';
import { ResultActions, ResultChecks, ResultStatus, WorkingLine } from './ResultCard';
import { latestResult } from './result-round';
import { AgentCommandRun } from './AgentCommandRun';
import { onComposerPrefill } from './composer-prefill';
import { QuoteChip } from './ReadingQuote';
import { quoteExcerpt, withQuote, type MessageQuote } from './message-quote';

import { ConversationDecorations, ConversationFeed } from './ConversationFeed';
export { Markdown } from './Markdown';
export { groupSummary } from './ResultCard';

// Switching to the CLI unmounts the composer; sent messages still belong to that terminal.
const history = new Map<string, string[]>();
type ServerPicture = { generation: number; src: string; path?: string; error?: string; ready?: Promise<void>; sent?: boolean };
// The entries on screen when /clear (or Codex's /new) was sent from here, per conversation. The agent starts a new
// conversation at once, but its file only appears with the next message; until then these stay hidden.
const cleared = new Map<string, ReadonlySet<string>>();
const clears = (agent: ProjectTerminal['agent'], text: string) => (agent === 'claude' ? /^\/clear(?:\s|$)/ : /^\/(?:clear|new)(?:\s|$)/).test(text.trim());
// Picture previews may still be decoding after the CLI has accepted the attachment.
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/;
// The agent's conversation laid out for reading: your prompts, its answers as Markdown with copyable code,
// and its tool calls folded between them. The real terminal stays underneath; what is written here goes to
// it, and the toggle in the card header switches back to it at any time. autoFocus: the card is expanded and
// this is its terminal in use, so the message box takes the keyboard (never a small card's).
export function ReadingView({ projectId, terminal, remote = false, autoFocus, active = true, onShowTerminal, onError, onOpenLink }: { projectId: string; terminal: ProjectTerminal; remote?: boolean; autoFocus: boolean; active?: boolean; onShowTerminal: () => void; onError: (message: string) => void; onOpenLink: (target: string) => void }) {
  const readingView = useRef<HTMLDivElement>(null);
  const kind = (terminal.agent ?? terminal.readingHistory?.agent) === 'claude' ? 'claude' : 'codex';
  const readingSession = terminal.sessionId;
  const thread = terminal.readingHistory?.threadId;
  const identity = useRef({ id: terminal.id, session: readingSession, thread, epoch: 0 });
  if (identity.current.id !== terminal.id || identity.current.session !== readingSession || thread && identity.current.thread && thread !== identity.current.thread) {
    identity.current = { id: terminal.id, session: readingSession, thread, epoch: identity.current.epoch + 1 };
  } else if (thread) identity.current.thread = thread;
  const epoch = identity.current.epoch;
  const conversation = JSON.stringify([terminal.id, readingSession, epoch]);
  const historyPage = useReadingHistory(terminal.id, terminal.sessionId, terminal.readingHistory);
  const conversationEntries = historyPage.entries;
  const [hidden, setHidden] = useState(() => cleared.get(conversation));
  useEffect(() => { setHidden(cleared.get(conversation)); }, [conversation]);
  // What /clear hid stays hidden only while that conversation is the one shown: once the agent has moved to another
  // (its new conversation came in), resuming the old one later shows it again rather than an empty page.
  useEffect(() => {
    if (!hidden || !conversationEntries.length || conversationEntries.some(entry => hidden.has(entry.id))) return;
    cleared.delete(conversation); setHidden(undefined);
  }, [conversationEntries, hidden, conversation]);
  const entries = useMemo(() => conversationEntries.filter(entry => !entry.queued && !hidden?.has(entry.id)), [conversationEntries, hidden]);
  const { pending, echo, cancelEcho } = usePendingPrompts(terminal.id, readingSession, conversationEntries, thread);
  // Queued records wait after the active turn, with or without a renderer echo. They never start a new agent turn.
  const cards = useMemo(() => pendingPromptCards(pending, conversationEntries.filter(entry => !hidden?.has(entry.id))), [pending, conversationEntries, hidden]);
  const queued = (prompt: PendingPrompt) => cards.queuedIds.has(prompt.id);
  const sendCounter = useRef(0);
  const visibleScreen = useScreen(terminal.id);
  const parsedScreen = useMemo(() => {
    const parsed = parseAgentScreen(kind, visibleScreen?.rows ?? []);
    return { ...parsed, choice: bindApproval(parsed.choice, kind, visibleScreen) };
  }, [terminal.agent, visibleScreen]);
  // Readiness outlives this component: a dialog with no input box must still show after a trip to the raw terminal.
  // Rendering only reads it; the effect remembers it.
  const inputShown = hasCliInput(kind, visibleScreen?.rows ?? [], parsedScreen);
  const run = { session: terminal.sessionId, thread, start: terminal.agentStartedAt, active: terminal.codexActive };
  const preview = !!terminal.readingHistory && !cliReady(terminal.id, run, inputShown);
  useEffect(() => rememberReady(terminal.id, run, inputShown));
  const screen = preview ? { ...parsedScreen, choice: null, waiting: null } : parsedScreen;
  const idleInput = inputShown && isAtPrompt(kind, visibleScreen?.rows ?? [], parsedScreen);
  const live = terminal.codexActive && !!terminal.sessionId && terminal.status !== 'exited';
  const knownDialog = cliDialogShown(kind, visibleScreen?.rows ?? [], parsedScreen) || terminal.needsInput != null && !idleInput;
  const working = live && !knownDialog && inputShown && isCliWorking(kind, visibleScreen?.rows ?? [], parsedScreen);
  const hasChoice = live && (knownDialog || !!visibleScreen && !idleInput && !working);
  // Activity can lag a mid-turn dialog. It gives unknown screens more time to settle, never a veto.
  const dialogSettle = DIALOG_SETTLE * (terminal.codexActivity === 'working' ? 2 : 1);
  const waiting = screen.waiting ?? (screen.choice ? { title: screen.choice.title } : null);
  const waitingShown = hasChoice;
  const absence = useRef<{ conversation: string; at: number | null }>({ conversation, at: null });
  if (absence.current.conversation !== conversation || !hasChoice) absence.current = { conversation, at: null };
  if (hasChoice) absence.current.at ??= Date.now();
  const welcomeIsStarting = useWelcomeStarting(terminal.agentStartedAt, screen);
  const choiceVisible = useRef(hasChoice), mounted = useRef(true);
  const choiceHost = useRef<HTMLDivElement>(null), restoreComposer = useRef(false), wasChoice = useRef(false), editingAtChoice = useRef(false);
  const [draft, setDraft] = useState('');
  const [sendingSoon, setSendingSoon] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[]>([]), [requested, setRequested] = useState(false);
  const [dismissed, setDismissed] = useState(false), [selection, setSelection] = useState(0);
  const historyAt = useRef<number | null>(null), unsent = useRef(''), caret = useRef<number | null>(null), sending = useRef(false);
  const interaction = useRef(0), pictureGeneration = useRef(0);
  const native = useNativePictures({ owner: conversation, terminalId: terminal.id, agent: kind, sending, interaction,
    blocked: () => choiceVisible.current, preserveDraft: text => pending.some(prompt => sameMessage(prompt.text, text)), onError });
  const images = native.images;
  // Reserve remote slots at paste time, so Send can await uploads in order without a stale render's path list.
  const serverPictures = useRef<ServerPicture[]>([]), [, setPictureTick] = useState(0);
  const clearPictures = () => { native.clear(); serverPictures.current = []; setPictureTick(tick => tick + 1); };
  useLayoutEffect(() => { pictureGeneration.current++; serverPictures.current = []; setPictureTick(tick => tick + 1); }, [conversation]);
  // One quoted message waits for the next message; the newest wins. The ref is what a send in flight reads.
  const [quote, setQuote] = useState<MessageQuote | null>(null), quoteRef = useRef<MessageQuote | null>(null);
  const holdQuote = (next: MessageQuote | null) => { quoteRef.current = next; setQuote(next); };
  useLayoutEffect(() => { holdQuote(null); }, [conversation]);
  const scroller = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), composer = useRef<HTMLDivElement>(null);
  const [terminalPopup, setTerminalPopup] = useState<{ command: string; focus?: boolean } | null>(null);
  const inputBlocked = preview || !live || !idleInput || working || hasChoice || terminalPopup !== null;
  choiceVisible.current = hasChoice || terminalPopup !== null;
  const focusAfterPopup = useRef(false);
  const popupReady = useRef<(() => void) | null>(null);
  const readyPopup = () => { popupReady.current?.(); popupReady.current = null; };
  const cancelSend = () => { sendCounter.current++; interaction.current++; sending.current = false; readyPopup(); };
  const closePopup = (restoreFocus = true) => {
    cancelSend(); focusAfterPopup.current = restoreFocus; setTerminalPopup(null);
  };
  // The popup disables the textarea; restore focus only after closing has enabled it in the DOM.
  useLayoutEffect(() => {
    if (terminalPopup !== null || !focusAfterPopup.current) return;
    focusAfterPopup.current = false;
    (inputBlocked ? composer.current : input.current)?.focus({ preventScroll: true });
  }, [terminalPopup, inputBlocked]);
  useLayoutEffect(() => {
    setTerminalPopup(null);
    return cancelSend;
  }, [terminal.id, terminal.sessionId, epoch, terminal.codexActive]);
  const ownership = useRef({ active, autoFocus });
  useLayoutEffect(() => {
    const previous = ownership.current; ownership.current = { active, autoFocus };
    if (previous.active && !active || previous.autoFocus && !autoFocus) { cancelSend(); setTerminalPopup(null); }
  }, [active, autoFocus]);
  // Unknown screens default to the TUI. A settled absence is one dialog episode, shared across remounts;
  // a hidden view never consumes its opening, and closing it does not rearm it on redraw.
  useEffect(() => {
    if (!live || idleInput && !knownDialog) { endDialog(terminal.id); return; }
    if (working) {
      const timer = setTimeout(() => endDialog(terminal.id), DIALOG_SETTLE);
      return () => clearTimeout(timer);
    }
    if (!hasChoice) return;
    const open = () => {
      if (!active || !startDialog(terminal.id, conversation) || terminalPopup !== null) return;
      const focus = !editingAtChoice.current && !hasEditingFocus(document.body) && !hasEditingFocus(readingView.current) && !isTyping(document.activeElement);
      cancelSend(); setTerminalPopup({ command: '', focus });
    };
    if (knownDialog) { open(); return; }
    const wait = Math.max(0, dialogSettle - (Date.now() - (absence.current.at ?? Date.now())));
    if (!wait) { open(); return; }
    const timer = setTimeout(open, wait);
    return () => clearTimeout(timer);
  }, [terminal.id, conversation, live, idleInput, knownDialog, hasChoice, active, working, dialogSettle]);
  const { stuck, unseen, toBottom, ready, holdPosition } = useStickToBottom(scroller, content, entries, conversation);
  useEffect(() => { if (stuck) void historyPage.compact(); }, [stuck, conversationEntries, historyPage.compact]);
  // A step hops only when the pointer moves onto it: moving arms the hops, any scroll disarms them until it moves again,
  // so the steps sliding under a still pointer stay put (marked on the element itself, without a render).
  useEffect(() => {
    const node = scroller.current; if (!node) return;
    const onMove = () => { if (!('hover' in node.dataset)) node.dataset.hover = ''; };
    const onScroll = () => { if ('hover' in node.dataset) delete node.dataset.hover; };
    node.addEventListener('pointermove', onMove, { passive: true }); node.addEventListener('scroll', onScroll, { passive: true });
    return () => { node.removeEventListener('pointermove', onMove); node.removeEventListener('scroll', onScroll); };
  }, [conversation]);
  useLayoutEffect(() => { if (caret.current !== null) { input.current?.setSelectionRange(caret.current, caret.current); caret.current = null; } });
  useEffect(() => { if (draft.startsWith('/') || !entries.length) setRequested(true); }, [draft, entries.length]);
  // Disabling a textarea can blur it before effects. Capture ownership before that DOM commit.
  if (hasChoice && !wasChoice.current) {
    restoreComposer.current = document.activeElement === input.current;
    editingAtChoice.current = hasEditingFocus(document.body) || hasEditingFocus(readingView.current) || isTyping(document.activeElement);
  }
  useLayoutEffect(() => {
    setChoiceVisible(terminal.id, hasChoice || terminalPopup !== null);
    if (hasChoice && restoreComposer.current && document.activeElement === document.body) composer.current?.focus({ preventScroll: true });
    if (!hasChoice && wasChoice.current) {
      if (restoreComposer.current && idleInput && (document.activeElement === document.body || document.activeElement === composer.current)) input.current?.focus();
      restoreComposer.current = false; editingAtChoice.current = false;
    }
    wasChoice.current = hasChoice;
  }, [terminal.id, hasChoice, terminalPopup, idleInput]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; setChoiceVisible(terminal.id, false);
    };
  }, [terminal.id]);
  useEffect(() => {
    setCommands([]);
    if (!requested) return;
    let active = true;
    void window.agentrix.terminalCommands(terminal.id).then(result => {
      if (active) { setCommands(result.ok ? result.value : []); if (!result.ok) onError(result.error); }
    }).catch(error => { if (active) onError(String(error)); });
    return () => { active = false; };
  }, [terminal.id, terminal.agent, requested]);
  const matches = useMemo(() => {
    const query = draft.slice(1).toLowerCase(), name = (command: AgentCommand) => command.name.slice(1).toLowerCase();
    // The command named exactly comes first (a project's /doc before the built-in /doctor), then those it begins.
    const rank = (command: AgentCommand) => name(command) === query ? 0 : name(command).startsWith(query) ? 1 : 2;
    return commands.filter(command => name(command).includes(query)).sort((a, b) => rank(a) - rank(b));
  }, [commands, draft]);
  // A command recalled from history (↑) is sent as it is: the list stays shut, so ↑ goes on through history.
  const palette = !inputBlocked && !dismissed && historyAt.current === null && /^\/[^\s]*$/.test(draft), selected = matches[selection];
  const listId = `reading-commands-${terminal.id}`, optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => { setSelection(0); }, [draft, commands]);
  useEffect(() => { if (palette) document.getElementById(optionId(selection))?.scrollIntoView({ block: 'nearest' }); }, [palette, selection]);
  const edit = (value: string) => { dictationSend.cancel(); setDraft(value); setDismissed(false); historyAt.current = null; };
  // Text written for this terminal on the home page waits here for the reader to send it.
  useEffect(() => onComposerPrefill(terminal.id, text => { dictationSend.cancel(); setDraft(text); setDismissed(true); requestAnimationFrame(() => input.current?.focus()); }), [terminal.id]);
  const complete = (command: AgentCommand) => {
    caret.current = command.name.length + 1; edit(command.name + ' '); input.current?.focus();
  };
  const mentions = useMentions({ projectId, draft, input, disabled: inputBlocked || /^\/[^\s]*$/.test(draft), edit, onError });
  useEffect(() => {
    if (!autoFocus || hasEditingFocus(readingView.current)) return;
    if (choiceVisible.current) { restoreComposer.current = true; (choiceHost.current?.firstElementChild as HTMLElement | null)?.focus(); }
    else if (terminalPopup === null) input.current?.focus();
  }, [terminal.id, autoFocus]);
  const agent = kind === 'claude' ? 'Claude Code' : 'Codex';
  const grouped = useMemo(() => blocks(entries), [entries]);
  const tail = useVisibleTail(grouped, conversation, scroller, stuck, holdPosition, historyPage);
  useEffect(() => {
    const node = scroller.current, sentinel = node?.querySelector('.reading-earlier');
    if (!node || !sentinel || !historyPage.paged || !tail.hasEarlier || historyPage.loading || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting && !stuck) void tail.showEarlier(); }, { root: node, rootMargin: '200px 0px 0px' });
    observer.observe(sentinel); return () => observer.disconnect();
  }, [conversation, tail.showEarlier, tail.hasEarlier, historyPage.loading, historyPage.paged, stuck]);
  // Returning from session A to B to A must not revive an earlier send's delayed keys.
  const ownsSend = (owner: number) => mounted.current && sendCounter.current === owner;
  const ownsPicture = (generation: number) => mounted.current && pictureGeneration.current === generation;
  const pictureNotAccepted = () => onError(t('图片未发送。请在输入框中移除后重新粘贴。'));
  const send = async (text = draft.trim(), own = true, automatic = false) => {
    if (own) dictationSend.cancel();
    if (sending.current) return;
    const owner = ++sendCounter.current;
    sending.current = true;
    try { await deliver(text, own, owner, automatic); } catch (error) { if (ownsSend(owner)) onError(String(error)); } finally { if (ownsSend(owner)) sending.current = false; }
  };
  const interrupt = () => window.agentrix.writeTerminal(terminal.id, '\x1b');
  // The CLI recognises slash commands and shell mode from typed keys, not bracketed paste.
  // own: written in the composer here (it is cleared, with its pictures); otherwise a message sent again, which leaves
  // whatever is being written now alone and takes no pictures with it.
  const deliver = async (words: string, own: boolean, owner: number, automatic: boolean) => {
    if (inputBlocked) return;
    if (!own && images.length) { onError(t('请先发送或移除输入框中的图片，再发送这条消息。')); return; }
    const batch = own ? images : [], uploads = own ? serverPictures.current.slice() : [];
    const pictureSend = !!(batch.length || uploads.length);
    if (uploads.length) {
      await Promise.all(uploads.map(picture => picture.ready));
      if (!ownsSend(owner) || choiceVisible.current) return;
      const failed = uploads.find(picture => !ownsPicture(picture.generation) || !picture.path);
      if (failed) { onError(failed.error ?? t('未送达：助手没有收到这条消息')); return; }
    }
    const attached = batch.map(image => image.src).filter(Boolean), pictures = uploads.map(picture => picture.path!);
    const plain = pictures.length ? (isTypedCommand(words) ? [words, ...pictures] : [...pictures, words]).filter(Boolean).join(' ') : words;
    // The quote goes only with the owner's own ordinary message: a command is typed as it is and leaves it for the next
    // message, and a message sent again (own = false) already carries its quote.
    const carried = own && words && !isTypedCommand(words) ? quoteRef.current : null;
    const text = withQuote(carried?.excerpt, plain);
    if ((!text && !batch.length) || !terminal.sessionId) return;
    // Commands clear the native input; they cannot silently consume pictures waiting for a normal message.
    if (batch.length && isTypedCommand(text)) { onError(t('请先发送或移除输入框中的图片，再发送这条消息。')); return; }
    const remember = () => { if (words) history.set(terminal.id, [...(history.get(terminal.id) || []), words].slice(-50)); };
    if (isTypedCommand(text)) {
      if (own) { edit(''); clearPictures(); }
      remember();
      const ready = new Promise<void>(resolve => { popupReady.current = resolve; });
      setTerminalPopup({ command: text });
      await ready;
      const sent = await typeReadingCommand(text, value => window.agentrix.writeTerminal(terminal.id, value), () => ownsSend(owner));
      if (sent && clears(terminal.agent, text)) { const ids = new Set(conversationEntries.map(entry => entry.id)); cleared.set(conversation, ids); setHidden(ids); }
      return;
    }
    // A closed popup can leave the CLI's dialog open. Looking is harmless; guessing a close key is not.
    if (!native.readInput()) {
      if (automatic) return;
      setTerminalPopup({ command: '' });
      return;
    }
    if (batch.length) {
      await native.prepare(batch);
      for (let attempt = 0; ; attempt++) {
        if (!ownsSend(owner) || choiceVisible.current) return;
        if (native.observe(batch)) break;
        if (attempt === 10) { pictureNotAccepted(); return; }
        await new Promise(resolve => setTimeout(resolve, 80));
      }
    }
    const pendingId = text || batch.length ? echo(text, attached, batch.length) : null;
    if (pendingId) toBottom();
    // From here the message shows as sent; the quote went with it, and returns with the draft if the send fails.
    if (carried && quoteRef.current === carried) holdQuote(null);
    const restoreQuote = () => { if (carried && !quoteRef.current && ownsSend(owner)) holdQuote(carried); };
    const left = text && !batch.length ? inputDraft() : '';
    const clearDraft = () => { if (own && input.current?.value.trim() === words) edit(''); };
    if (own && !pictureSend) edit('');
    if (left && sameMessage(text, left)) {
      uploads.forEach(picture => { picture.sent = true; });
      if (pictureSend) clearDraft(); if (own) clearPictures();
      toBottom(); window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(text, owner);
      remember(); return;
    }
    if (left && pending.some(prompt => sameMessage(prompt.text, left))) { window.agentrix.writeTerminal(terminal.id, '\r'); await submitted(left, owner); }
    else if (left && !IMAGE_PLACEHOLDER.test(left)) await native.clearInput(() => ownsSend(owner));
    if (!ownsSend(owner)) return;
    if (text) {
      const pasted = await window.agentrix.pasteTerminal(terminal.id, text, terminal.sessionId);
      if (!ownsSend(owner)) return;
      if (!pasted.ok) {
        if (pendingId) cancelEcho(pendingId);
        restoreQuote();
        if (own && !pictureSend && !input.current?.value) edit(words);
        onError(pasted.error); return;
      }
      remember();
    }
    if (pictureSend) clearDraft();
    toBottom();
    if (text) await new Promise(resolve => setTimeout(resolve, 400));
    if (!ownsSend(owner) || choiceVisible.current) {
      if (pendingId) cancelEcho(pendingId);
      restoreQuote();
      if (ownsSend(owner) && own && !input.current?.value) edit(words);
      return;
    }
    if (batch.length && !native.observe(batch)) {
      if (pendingId) cancelEcho(pendingId);
      restoreQuote();
      if (own && !input.current?.value) edit(words);
      pictureNotAccepted(); return;
    }
    uploads.forEach(picture => { picture.sent = true; });
    if (own) clearPictures();
    window.agentrix.writeTerminal(terminal.id, '\r');
    if (text) await submitted(text, owner);
  };
  const inputDraft = () => native.readInput()?.text ?? '';
  // A message is sent once it has left the CLI's input. An Enter the CLI did not take (it arrived while the CLI was
  // busy redrawing, compacting or taking the paste) leaves it there: Enter again, a few times.
  const submitted = async (text: string, owner: number) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 700));
      if (!ownsSend(owner) || choiceVisible.current || !sameMessage(text, inputDraft())) return;
      window.agentrix.writeTerminal(terminal.id, '\r');
    }
  };
  const sendRef = useRef(send); sendRef.current = send;
  const [dictationSend] = useState(() => createDictationSend(() => { void sendRef.current(); }, setSendingSoon));
  // A terminal can stay mounted when another split is selected. Cancel before it loses composer ownership.
  useLayoutEffect(() => () => { dictationSend.cancel(); }, [dictationSend, terminal.id, terminal.sessionId, active, autoFocus]);
  // A command another part of the window sends this agent (the activity pane's limit reset) goes as one typed here
  // would, its popup showing what the agent answers.
  useEffect(() => {
    const take = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId: string; text: string }>).detail;
      if (detail?.terminalId !== terminal.id) return;
      event.preventDefault(); void sendRef.current(detail.text, false);
    };
    window.addEventListener('agentrix:command', take);
    return () => window.removeEventListener('agentrix:command', take);
  }, [terminal.id]);
  // The safety net: a message no record has shown once its echo timed out, while the agent sits idle, is sent again
  // (twice at most). Only the pending-prompt reconciler can acknowledge a matching, newly observed record.
  const retries = useRef({ conversation, counts: new Map<string, number>() });
  if (retries.current.conversation !== conversation) retries.current = { conversation, counts: new Map() };
  const resent = retries.current.counts;
  const [idleSince, setIdleSince] = useState(() => Date.now()), [, setTick] = useState(0);
  useEffect(() => { if (!working) setIdleSince(Date.now()); }, [working]);
  // A message in Claude Code's queue has arrived: it is taken up when the current step is done, never sent again.
  const stalled = pending.filter(prompt => !prompt.sending && !queued(prompt)), idle = !preview && !working && terminalPopup === null && !hasChoice && Date.now() - idleSince >= 5000;
  useEffect(() => {
    if (preview || !stalled.length || working || terminalPopup !== null || hasChoice || images.length) return;
    const wait = idleSince + 5000 - Date.now();
    if (wait > 0) { const timer = setTimeout(() => setTick(tick => tick + 1), wait + 50); return () => clearTimeout(timer); }
    for (const prompt of stalled) {
      if (prompt.imageCount) continue; // Native image bytes cannot be reconstructed by retrying its text.
      const tries = resent.get(prompt.text) ?? 0;
      if (tries >= 2 || sending.current) continue;
      resent.set(prompt.text, tries + 1);
      cancelEcho(prompt.id); void sendRef.current(prompt.text, false, true);
      break;
    }
  });
  const undelivered = (prompt: PendingPrompt) => idle && !prompt.sending && !queued(prompt) && (!!prompt.imageCount || (resent.get(prompt.text) ?? 0) >= 2);
  const resend = (prompt: PendingPrompt) => {
    if (prompt.imageCount || images.length) {
      onError(prompt.imageCount ? t('图片是否送达尚未确认。请先在终端中检查对话，再决定是否重新发送。') : t('请先发送或移除输入框中的图片，再发送这条消息。')); return;
    }
    cancelEcho(prompt.id); void send(prompt.text, false, true);
  };
  // Dictation into this terminal lands here while the reading view shows: the words appear at the cursor as
  // soon as they are recognised. Enter (or the shortcut again) allows a second to edit before sending normally.
  useEffect(() => dictateInto(terminal.id, (text, submit) => {
    if (choiceVisible.current || terminalPopup !== null) return;
    const node = input.current, value = node?.value ?? '', here = !!node && document.activeElement === node;
    const at = here ? node.selectionStart : value.length, end = here ? node.selectionEnd : value.length;
    const next = value.slice(0, at) + text + value.slice(end);
    caret.current = at + text.length; edit(next); node?.focus();
    if (submit) dictationSend.start();
  }), [terminal.id]);
  // SSH receives a saved file; the native-picture hook stages local attachments in the CLI.
  const pasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const generation = pictureGeneration.current;
    const data = event.clipboardData;
    if (data.getData('text/plain')) return;
    const item = [...data.items].find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault();
    if (sending.current) return;
    if (inputBlocked || choiceVisible.current) { onError(t('图片未能附加，已从输入框移除。请等终端准备好后重新粘贴。')); return; }
    if (!terminal.codexActive || !terminal.sessionId) { onError(t('启动 Codex 或 Claude Code 后才能粘贴图片。')); return; }
    const file = item.getAsFile();
    if (!file) return;
    if (!remote && file.size > 25 * 1024 * 1024) { onError(t('图片太大（超过 25 MB），请压缩后再粘贴。')); return; }
    // A fifth native paste would leave an invisible attachment behind when the four-preview window rolls over.
    if (images.length + serverPictures.current.length >= 4) { onError(t('最多附加 4 张图片，请先移除一张。')); return; }
    // Over SSH the CLI cannot reach this computer's clipboard: the picture goes over as a file on that computer, whose
    // path joins the message when it is sent (serverPictures).
    if (remote) {
      const picture: ServerPicture = { generation, src: '' };
      serverPictures.current.push(picture); setPictureTick(tick => tick + 1);
      const retained = () => ownsPicture(generation) && (picture.sent || serverPictures.current.includes(picture));
      picture.ready = file.arrayBuffer().then(bytes => window.agentrix.saveImage(terminal.id, bytes, file.type)).then(saved => {
        if (!retained()) return;
        if (!saved.ok) throw new Error(saved.error);
        picture.path = saved.value;
        if (picture.src) rememberPicture(saved.value, picture.src);
      }).catch(error => { if (retained()) { picture.error = String(error instanceof Error ? error.message : error); if (!sending.current) onError(picture.error); } });
      void thumbnail(file).catch(() => dataUrl(file)).then(small => {
        if (!retained()) return;
        picture.src = small;
        if (picture.path) rememberPicture(picture.path, small);
        setPictureTick(tick => tick + 1);
      }).catch(() => { if (retained()) onError(t('无法读取这张图片。')); });
      return;
    }
    native.paste(file);
  };
  const shownImages = [...images.map(image => image.src), ...serverPictures.current.map(picture => picture.src)];
  const imageNumbers = native.numbers;
  const attachedCount = images.length + serverPictures.current.length;
  const removeImage = async (index: number) => {
    input.current?.focus();
    if (sending.current) return;
    if (index >= images.length) { serverPictures.current.splice(index - images.length, 1); setPictureTick(tick => tick + 1); return; }
    await native.remove(index);
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && dictationSend.cancel()) { event.preventDefault(); event.stopPropagation(); return; }
    if (inputBlocked || choiceVisible.current) { event.preventDefault(); event.stopPropagation(); return; }
    markTyping(event.currentTarget);
    if (event.nativeEvent.isComposing) { dictationSend.cancel(); return; }
    if (event.key === 'Enter') dictationSend.cancel();
    if (event.key === 'Tab' && event.shiftKey) { event.preventDefault(); window.agentrix.writeTerminal(terminal.id, '\x1b[Z'); return; }
    if (mentions.keys(event)) return;
    if (palette) {
      if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); if (matches.length) setSelection(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length); return; }
      if (selected && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))) {
        event.preventDefault(); if (event.key === 'Enter' && draft === selected.name) void send(); else complete(selected); return;
      }
    } else {
      if (event.key === 'Escape') { if (working) { event.preventDefault(); interrupt(); } return; }
      const node = event.currentTarget, sent = history.get(terminal.id) || [];
      if (!event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && node.selectionStart === node.selectionEnd && ((event.key === 'ArrowUp' && node.selectionStart === 0) || (event.key === 'ArrowDown' && node.selectionEnd === draft.length))) {
        if (event.key === 'ArrowUp' && sent.length) {
          event.preventDefault(); dictationSend.cancel(); if (historyAt.current === null) { unsent.current = draft; historyAt.current = sent.length; }
          historyAt.current = Math.max(0, historyAt.current - 1); caret.current = 0; setDraft(sent[historyAt.current]);
        } else if (event.key === 'ArrowDown' && historyAt.current !== null) {
          event.preventDefault(); dictationSend.cancel(); historyAt.current++;
          const next = historyAt.current >= sent.length ? unsent.current : sent[historyAt.current];
          if (historyAt.current >= sent.length) historyAt.current = null;
          caret.current = next.length; setDraft(next);
        } else return;
        node.setSelectionRange(caret.current!, caret.current!);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
  };
  // What the agent is doing, written at the end of the conversation the way its CLI writes it, never in a corner.
  const statusRunning = working || pending.some(prompt => prompt.sending);
  const status = screen.choice?.kind === 'question' ? <div className="reading-status is-waiting" role="status">{t('等待你回答问题')}</div>
    // Without a choice to answer here (one the reading view cannot lay out), the terminal is a click away.
    : terminal.needsInput !== null ? <div className="reading-status is-waiting" role="status"><span>{t('等待你确认：{message}', { message: terminal.needsInput })}</span>
      {!screen.choice && <button type="button" className="text-button" onClick={onShowTerminal}>{t('切换到终端')}</button>}</div>
    : statusRunning ? <WorkingLine key={terminal.sessionId} agent={kind} label={terminal.action ? t('正在{step}', { step: actionText(terminal.action) }) : t('{agent} 正在思考', { agent })} />
    : null;
  // The latest round once it has ended gets its status above the result and its actions under it; nothing while the agent
  // works or waits, and nothing for earlier rounds.
  const settled = !status && !statusRunning && terminal.codexActive && !cards.prompts.length && !hasChoice, interrupted = terminal.codexActivity === 'interrupted';
  const result = useMemo(() => latestResult(entries, { idle: settled, interrupted }), [entries, settled, interrupted]);
  // Only the owner's click on a message's 引用 gets here, so only it moves the keyboard to the message box.
  const quoteMessage = (who: string, text: string) => {
    const excerpt = quoteExcerpt(text);
    if (excerpt) { holdQuote({ who, excerpt }); input.current?.focus(); }
  };
  const continueWith = (prefill?: string) => {
    if (prefill && !draft.trim()) { caret.current = prefill.length; edit(prefill); }
    input.current?.focus();
  };
  const resultStatus = result && <ResultStatus result={result} taskTitle={terminal.taskTitle} onShowTerminal={onShowTerminal} onError={onError} />;
  const resultActions = result && <>
    {result.kind === 'code' && <ResultChecks result={result} />}
    <ResultActions result={result} projectId={projectId} remote={remote} canSend={!inputBlocked && !!terminal.sessionId} onContinue={continueWith} onRetry={() => void send(result.request, false)} onError={onError} />
  </>;
  const lastBlock = grouped.at(-1);
  const statusInTurn = !!lastBlock && (lastBlock.kind === 'tools' || lastBlock.entry.role !== 'user') && pending.every(queued);
  const afterFeed = <><PendingPromptEntries prompts={cards.prompts} queued={queued} undelivered={undelivered} onResend={resend} onDiscard={prompt => cancelEcho(prompt.id)} />
    {status && !statusInTurn && <TimelineStep at={pending.at(-1)?.at ?? entries.at(-1)?.at} kind="agent" who={agent} state={statusRunning ? 'running' : null} agent={kind} mark={<AgentMark agent={kind} />}>{status}</TimelineStep>}</>;
  const beforeFeed = terminal.agentCommand ? <AgentCommandRun agent={kind} command={terminal.agentCommand} rows={visibleScreen?.rows ?? []} onShowTerminal={onShowTerminal} />
    : !entries.length && !cards.prompts.length ? <ReadingWelcome agent={kind} commands={commands} complete={complete} disabled={inputBlocked} screen={screen} starting={welcomeIsStarting} /> : <>
    {tail.hasEarlier && <button type="button" className="text-button reading-earlier" disabled={historyPage.loading} onClick={() => void tail.showEarlier()}>{historyPage.paged ? t('显示更早的对话') : t('显示更早的对话（{count}）', { count: tail.earlier })}</button>}
    {historyPage.error && <p role="status">{t(historyPage.error)}</p>}</>;
  const body = <ConversationDecorations.Provider value={{ start: tail.earlier, status: statusInTurn ? status : null, running: statusRunning, anchor: result?.anchor, beforeResult: resultStatus, afterResult: resultActions,
    quote: { disabled: inputBlocked ? t('输入框暂时不可用，等它可用后再引用') : null, pick: quoteMessage },
    frame: { ref: content, style: { visibility: entries.length && !ready ? 'hidden' : undefined }, before: beforeFeed } }}>
      <ConversationFeed entries={terminal.agentCommand ? [] : entries} agent={kind} projectId={projectId} live={!settled} onError={onError} onOpenLink={onOpenLink}>{afterFeed}</ConversationFeed>
    </ConversationDecorations.Provider>;
  // The hint, longest first: the box shows the first that fits its width, so a narrow composer gets a short hint instead of a cut-off one.
  const hint = useFittingHint(input, preview ? [t('正在启动…')] : result ? [t('继续修改，或描述下一步…'), t('继续修改…')] : terminal.codexActive
    ? [t('给 {agent} 发消息，/ 查看命令，@ 提及文件，Enter 发送，Shift+Enter 换行', { agent }), t('给 {agent} 发消息，/ 查看命令，@ 提及文件', { agent }), t('给 {agent} 发消息', { agent })]
    : [t('输入命令，Enter 发送'), t('输入命令')]);
  return <div className="reading-view" data-agent={kind} ref={readingView}>
    <div className="reading-scroll-area">
      <div className="reading-scroll" ref={scroller} tabIndex={0}>{body}</div>
      {!stuck && <div className="reading-latest">
        {unseen > 0 && <span className="reading-unseen" role="status">{t('{count} 条新消息', { count: unseen })}</span>}
        <button type="button" className="icon-button reading-jump" title={t('跳到最新消息')} aria-label={t('跳到最新消息')} onClick={() => toBottom('smooth')}><ArrowDown size={18} /></button>
      </div>}
      {terminalPopup !== null && <ReadingTerminalPopup key={sendCounter.current} terminalId={terminal.id} sessionId={terminal.sessionId} command={terminalPopup.command} focus={terminalPopup.focus} onReady={readyPopup} onClose={closePopup} onError={onError} />}
    </div>
    {attachedCount > 0 && <div className="reading-attachments" role="status"><ImageIcon size={14} />{t('已附加 {count} 张图片，随下一条消息发送', { count: attachedCount })}<UserImages images={shownImages} numbers={imageNumbers} onRemove={index => void removeImage(index)} /></div>}
    {quote && <QuoteChip quote={quote} onRemove={() => { holdQuote(null); input.current?.focus(); }} />}
    {waitingShown && terminalPopup === null && <div className="reading-choice-host" ref={choiceHost}><WaitingCard title={waiting?.title ?? null} terminalId={terminal.id} onOpenTerminal={() => setTerminalPopup({ command: '' })} /></div>}
    {/* The command list is part of the page, above the message box, not a popup over the conversation. */}
    {palette && <div className="reading-commands is-inline" id={listId} role="listbox" aria-label={t('命令')}>{matches.map((command, index) => <div key={command.name} id={optionId(index)} role="option" aria-selected={selection === index} className="reading-command" onMouseDown={event => event.preventDefault()} onClick={() => complete(command)}>
        <code>{command.name}</code><span>{command.source === 'builtin' ? t(command.description) : command.description}</span>{command.source !== 'builtin' && <small>{command.source === 'project' ? t('项目') : command.source === 'user' ? t('用户') : t('技能')}</small>}
    </div>)}</div>}
    <div ref={composer} tabIndex={-1} className={`reading-composer${sendingSoon ? ' is-sending-soon' : ''}`} style={terminal.agentCommand ? { display: 'none' } : undefined}>
      <MentionPalette mentions={mentions} />
      <textarea ref={input} rows={1} disabled={inputBlocked} onPaste={pasteImage} onSelect={mentions.trackCaret} aria-label={t('给 {agent} 的消息', { agent })} aria-expanded={palette || mentions.open} aria-controls={palette ? listId : mentions.open ? mentions.listId : undefined} aria-activedescendant={palette && selected ? optionId(selection) : mentions.open && mentions.files[mentions.selection] ? mentions.optionId(mentions.selection) : undefined} placeholder={hint} value={draft} onChange={event => edit(event.target.value)} onKeyDown={keys}
        onCompositionStart={() => dictationSend.cancel()} onFocus={() => window.agentrix.terminalFocus(terminal.id, false)} />
      {working && <button type="button" className="icon-button" disabled={inputBlocked} title={t('中断（Esc）')} aria-label={t('中断（Esc）')} onClick={interrupt}><Stop size={15} weight="fill" /></button>}
      <button type="button" className="icon-button reading-send" title={t('发送')} aria-label={t('发送')} disabled={inputBlocked || (!draft.trim() && !attachedCount) || !terminal.sessionId} onClick={() => void send()}><PaperPlaneRight size={15} weight="fill" /></button>
    </div>
  </div>;
}
