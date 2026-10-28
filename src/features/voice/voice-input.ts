import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { MicrophoneCapture } from './voice-audio';
import type { VoiceState } from '../../shared/types';
import { t } from '../../shared/i18n';
import { shortcut } from '../shortcuts/shortcuts';
import { isMac, isLinux } from '../../shared/platform';

// One shared dictation controller: a single microphone, one recording at a time,
// and every terminal's microphone button reflecting the same device and model state.
// label names the terminal being dictated to; sending marks a recognition that will press Enter; sends: Enter sends
// what was said (a box that only takes the words, such as the decision page's, has Enter insert them instead).
type VoiceSnapshot = { microphone: boolean | null; model: VoiceState | null; recording: string | null; busy: string | null; label: string | null; sending: boolean; sends: boolean };
let snapshot: VoiceSnapshot = { microphone: null, model: null, recording: null, busy: null, label: null, sending: false, sends: true };
// Audio messages update the meter without notifying React's voice-state subscribers.
let measuredLevel = 0;
export function getVoiceLevel() { return measuredLevel; }
const listeners = new Set<() => void>();
const set = (patch: Partial<VoiceSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };

const capture = new MicrophoneCapture();
let target: { id: string; sessionId: string; onError: (message: string) => void } | null = null;
let started = false;
// Microphone opens run one after another, so a cancelled open that finishes late never closes a newer recording.
let opening: Promise<unknown> = Promise.resolve();
// The terminal the user last clicked or typed in, for Ctrl+T when keyboard focus is elsewhere.
let lastTerminal: string | null = null;
// A reading view showing a terminal's conversation takes the words dictated to that terminal into its message
// box instead (submit: send them as the next message). A text box of its own, such as the decision page's
// (data-voice-target="<id>" on it, for the shortcut), takes dictation under its id with no terminal at all;
// sends: false when Enter only puts the words in.
type Composer = { insert: (text: string, submit: boolean) => void; sends: boolean };
const composers = new Map<string, Composer>();
export function dictateInto(id: string, insert: (text: string, submit: boolean) => void, sends = true) {
  const composer = { insert, sends };
  composers.set(id, composer);
  return () => { if (composers.get(id) === composer) composers.delete(id); };
}
// Such a text box (the decision page's new work, a review's comments): the words go in at its caret, or at the end
// when it has no focus, and Enter only puts them in; sending stays the box's own button.
export function useDictatedBox(id: string, box: RefObject<HTMLTextAreaElement | null>, setText: (text: string) => void) {
  useEffect(() => dictateInto(id, words => {
    const node = box.current;
    if (!node) return;
    const here = document.activeElement === node, at = here ? node.selectionStart : node.value.length, end = here ? node.selectionEnd : node.value.length;
    setText(node.value.slice(0, at) + words + node.value.slice(end));
    node.focus();
    requestAnimationFrame(() => node.setSelectionRange(at + words.length, at + words.length));
  }, false), [id]);
}
// Codex and Claude Code treat an Enter that arrives right after pasted text as part of the paste
// (a newline), so the submitting Enter waits until the paste has landed.
const SUBMIT_DELAY = 400;

async function refreshMicrophone() {
  try { set({ microphone: (await navigator.mediaDevices.enumerateDevices()).some(device => device.kind === 'audioinput') }); }
  catch { set({ microphone: false }); }
}

function start() {
  if (started) return; started = true;
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshMicrophone());
  void refreshMicrophone();
  window.agentrix.onVoiceState(model => set({ model }));
  void window.agentrix.getVoiceState().then(result => { if (result.ok) set({ model: result.value }); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && snapshot.recording) void cancelDictation(); });
  document.addEventListener('focusin', event => {
    const id = (event.target as Element | null)?.closest?.<HTMLElement>('[data-terminal-id]')?.dataset.terminalId;
    if (id) lastTerminal = id;
  });
  // While recording, Enter and Escape belong to dictation and never reach the terminal.
  document.addEventListener('keydown', event => {
    if (!snapshot.recording || event.isComposing || (event.key !== 'Escape' && event.key !== 'Enter')) return;
    event.preventDefault(); event.stopPropagation();
    void (event.key === 'Escape' ? cancelDictation() : finish(true));
  }, true);
}

function subscribe(listener: () => void) { start(); listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useVoice() { return useSyncExternalStore(subscribe, () => snapshot); }

function microphoneMessage(error: unknown) {
  const name = (error as DOMException)?.name;
  if (name === 'NotAllowedError') return isMac ? t('麦克风访问被拒绝，请在“系统设置 › 隐私与安全性 › 麦克风”中允许 Agentrix。') : isLinux ? t('麦克风访问被拒绝，请在系统的隐私或声音设置中允许 Agentrix 使用麦克风。') : t('麦克风访问被拒绝，请在 Windows 设置中允许桌面应用使用麦克风。');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('未检测到麦克风，请连接后重试。');
  if (name === 'NotReadableError') return t('麦克风无法使用，可能正被其他程序占用。');
  // Messages thrown in Chinese by the capture code (voice-audio.ts) are looked up here.
  return t(String((error as Error)?.message || error));
}

function focusTerminal(id: string) {
  document.querySelector<HTMLTextAreaElement>(`[data-terminal-id="${CSS.escape(id)}"] .xterm-helper-textarea`)?.focus();
}

async function cancelDictation() {
  target = null; measuredLevel = 0; await capture.close(); set({ recording: null, label: null });
}

// submit: press Enter after inserting, so the text is sent as the next prompt.
async function finish(submit = false) {
  const current = target; if (!current) return;
  target = null; measuredLevel = 0; set({ recording: null, busy: current.id, sending: submit && snapshot.sends });
  try {
    const wav = await capture.stopRecording(); await capture.close();
    const text = await window.agentrix.transcribe(wav);
    if (!text.ok) throw new Error(text.error);
    if (!text.value.trim()) throw new Error(t('没有识别出文字，请再说一遍。'));
    const composer = composers.get(current.id);
    if (composer) { composer.insert(text.value.trim(), submit && composer.sends); return; }
    const pasted = await window.agentrix.pasteTerminal(current.id, text.value, current.sessionId);
    if (!pasted.ok) throw new Error(pasted.error);
    if (submit) { await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY)); window.agentrix.writeTerminal(current.id, '\r'); }
    focusTerminal(current.id);
  } catch (error) { current.onError(microphoneMessage(error)); }
  finally { await capture.close(); set({ busy: null, sending: false, label: null }); }
}

// Click once to start talking. Click again to insert the recognised text into this terminal's input
// for review, or press Enter (or Ctrl+T) to insert it and send it.
export async function toggleDictation(id: string, sessionId: string | null, onError: (message: string) => void, label = '') {
  if (snapshot.busy) return onError(t('正在识别上一段语音，请稍候。'));
  if (snapshot.recording) return snapshot.recording === id ? finish() : onError(t('另一个终端正在录音，请先结束那一段。'));
  if (!sessionId && !composers.has(id)) return onError(t('请先启动终端，再使用语音输入。'));
  if (snapshot.microphone === false) { void refreshMicrophone(); return onError(t('未检测到麦克风，请连接后重试。')); }
  if (!snapshot.model?.ready) {
    if (snapshot.model?.phase === 'downloading') return onError(t('语音模型正在下载（{percent}%），完成后即可使用。', { percent: snapshot.model.percent }));
    void window.agentrix.prepareVoice();
    return onError(t('语音模型开始下载，完成后即可使用。'));
  }
  // Recording counts from the keypress or click, so an Escape while the microphone is still opening cancels it.
  const pending = { id, sessionId: sessionId ?? '', onError };
  target = pending; measuredLevel = 0; set({ recording: id, label: label || null, sends: composers.get(id)?.sends ?? true });
  // The recognizer is released after a few idle minutes; load it again while the user is speaking.
  void window.agentrix.warmVoice();
  const opened = opening.then(() => target === pending ? capture.open('', level => {
    if (target === pending) measuredLevel = Math.min(1, level * 5);
  }) : undefined);
  opening = opened.catch(() => {});
  try {
    await opened;
    // Cancelled or finished while opening: release the microphone unless a newer dictation already owns it.
    if (target !== pending) { if (!target) await capture.close(); return; }
    capture.onLimit = () => void finish();
    capture.startRecording();
    set({ microphone: true });
  } catch (error) {
    if (target === pending) { target = null; measuredLevel = 0; set({ recording: null, label: null }); }
    if (!target) await capture.close();
    onError(microphoneMessage(error)); void refreshMicrophone();
  }
}

const shown = (element: HTMLElement | null | undefined) => element?.getClientRects().length ? element : null;

// Ctrl+T talks to the terminal or text box of its own with keyboard focus, else a text box of its own on screen (the
// decision page covers the terminals), else the expanded project's current terminal, else the terminal last used, else
// the only terminal on screen.
function terminalTarget() {
  const byId = (id: string | null) => id ? shown(document.querySelector<HTMLElement>(`[data-terminal-id="${CSS.escape(id)}"]`)) : null;
  const box = (element: HTMLElement | null | undefined) => element && composers.has(element.dataset.voiceTarget!) ? shown(element) : null;
  const preferred = shown(document.activeElement?.closest<HTMLElement>('[data-terminal-id]'))
    || box(document.activeElement?.closest<HTMLElement>('[data-voice-target]'))
    || [...document.querySelectorAll<HTMLElement>('[data-voice-target]')].find(element => box(element))
    || shown(document.querySelector<HTMLElement>('.project-panel.is-focused .is-active-terminal'))
    || byId(lastTerminal);
  if (preferred) return preferred;
  const visible = [...document.querySelectorAll<HTMLElement>('[data-terminal-id]')].filter(element => shown(element));
  return visible.length === 1 ? visible[0] : null;
}

// Ctrl+T starts talking to the current terminal; pressing it again works like Enter and sends the text.
export async function quickDictation(onError: (message: string) => void) {
  if (snapshot.recording) return finish(true);
  if (snapshot.busy) return onError(t('正在识别上一段语音，请稍候。'));
  const terminal = terminalTarget(), id = terminal?.dataset.terminalId || terminal?.dataset.voiceTarget;
  if (!terminal || !id) return onError(t('先点一下要输入的终端，再按 {key} 说话。', { key: shortcut('voice') }));
  return toggleDictation(id, terminal.dataset.sessionId || null, onError, terminal.getAttribute('aria-label') || '');
}
