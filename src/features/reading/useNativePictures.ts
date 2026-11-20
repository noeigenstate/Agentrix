import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../../shared/i18n';
import { isWindows } from '../../shared/platform';
import { dataUrl, thumbnail } from '../../shared/image-thumbnail';
import { parseAgentScreen } from '../agents/agent-screen';
import { readScreen, subscribeParsed, type Screen } from '../terminal/terminal-screen';
import { cliDialogShown, cliInputAvailable, cliInputDraft } from './cli-panel';
import { imageRemoval, inputImageLabels } from './image-input';
import { normalizePrompt } from './pending-prompts';

export type NativeImage = { id: number; src: string };
type Paste = { before?: string[]; label?: string; ready?: Promise<void>; conflicted?: boolean };
type Options = { owner: string; terminalId: string; sessionId: string | null; agent: 'claude' | 'codex'; sending: RefObject<boolean>; interaction: RefObject<number>;
  onParsed: () => void; blocked: (frame?: Screen) => boolean; preserveDraft: (text: string) => boolean; onError: (message: string) => void };

export function useNativePictures({ owner, terminalId, sessionId, agent, sending, interaction, onParsed, blocked, preserveDraft, onError }: Options) {
  const sequence = useRef(0), lifetime = useRef({ owner, alive: true, pastes: new Map<number, Paste>() });
  if (lifetime.current.owner !== owner) lifetime.current = { owner, alive: true, pastes: new Map() };
  const context = lifetime.current, valid = () => lifetime.current === context && context.alive;
  const parsed = useRef(onParsed); parsed.current = onParsed;
  useEffect(() => subscribeParsed(terminalId, () => parsed.current()), [terminalId, context]);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; images: NativeImage[] }>({ context, images: [] });
  const images = snapshot.context === context ? snapshot.images : [];
  useLayoutEffect(() => {
    context.alive = true;
    setSnapshot(previous => previous.context === context ? previous : { context, images: [] });
    return () => { context.alive = false; };
  }, [context]);
  const clear = () => { context.pastes.clear(); setSnapshot({ context, images: [] }); };
  const discard = (id: number) => {
    context.pastes.delete(id);
    setSnapshot(previous => previous.context === context ? { context, images: previous.images.filter(image => image.id !== id) } : previous);
  };
  const readInput = (admit = false) => {
    const current = readScreen(terminalId);
    if (!valid() || !current || current.sessionId != null && current.sessionId !== sessionId || current.pending && (!admit || !current.parsed) || blocked(current)) return null;
    const screen = { ...parseAgentScreen(agent, current.rows), inputHint: current.inputHint };
    if (!cliInputAvailable(agent, current.rows) || cliDialogShown(agent, current.rows, screen)) return null;
    return { rows: current.rows, text: cliInputDraft(agent, current.rows, screen), epoch: current.epoch, parse: current.parse };
  };
  // A cached parse may admit a message; every mutation requires all queued output to have parsed first.
  const parsing = () => !!readScreen(terminalId)?.pending;
  // A parsed frame showing a dialog, a menu or a picker.
  const dialogShown = () => {
    const shown = readScreen(terminalId);
    return !!shown && (!shown.pending || shown.parsed) && cliDialogShown(agent, shown.rows, parseAgentScreen(agent, shown.rows));
  };
  // The input on the first parsed frame that draws it: a busy agent's redraw can leave it out for a moment. Nothing once
  // a dialog takes its place, the caller lets go, or it stays away past the limit.
  const awaitInput = (owns: () => boolean, limit = 2000, admit = false) => new Promise<ReturnType<typeof readInput>>(resolve => {
    let off = () => {}, timer: ReturnType<typeof setTimeout> | undefined, done = false;
    const finish = (input: ReturnType<typeof readInput>) => {
      if (done) return;
      done = true; off(); clearTimeout(timer); resolve(input);
    };
    const look = () => {
      if (!valid() || !owns()) { finish(null); return; }
      const current = readInput(admit);
      if (current || dialogShown() || blocked()) finish(current);
    };
    off = subscribeParsed(terminalId, look);
    if (done) off();
    else { timer = setTimeout(() => finish(null), limit); look(); }
  });
  const settle = (owns: () => boolean, limit = 500) => awaitInput(owns, limit);
  // True once the input is empty; false when it went away (a dialog took its place), would not clear, or the caller let go.
  const clearInput = async (owns: () => boolean, epoch = readScreen(terminalId)?.epoch, expected = readInput()?.text) => {
    let previous = normalizePrompt(expected ?? '');
    for (let tries = 0; owns(); tries++) {
      if (parsing()) await settle(owns);
      const current = owns() ? readInput() : null;
      if (!current || current.epoch !== epoch) return false;
      const text = normalizePrompt(current.text);
      if (!text) return true;
      // Ctrl+U may erase one line at a time. Continue only after a strict reduction of the text we last checked.
      const expectedChange = tries === 0 ? text === previous : text.length < previous.length && previous.startsWith(text);
      if (tries === 30 || !expectedChange) return false;
      previous = text;
      window.agentrix.writeTerminal(terminalId, '\x15'); await new Promise(resolve => setTimeout(resolve, 80));
    }
    return false;
  };
  // Observe a new chip only against this paste's exact baseline; existing chips are not receipts for a later paste.
  const observe = (batch: readonly NativeImage[] = images) => {
    const current = readInput();
    if (!valid() || !current) return false;
    const labels = inputImageLabels(current.text), pastes = batch.map(image => context.pastes.get(image.id));
    for (const paste of pastes) {
      if (!paste || paste.conflicted) return false;
      const before = paste.before;
      if (!paste.label && before && labels.length === before.length + 1 && before.every((label, index) => labels[index] === label)
        && !before.includes(labels[labels.length - 1])) paste.label = labels[labels.length - 1];
    }
    return pastes.every((paste, index) => !!paste?.label && labels[labels.length - pastes.length + index] === paste.label);
  };
  const paste = (file: File) => {
    if (images.length && !observe()) {
      // A second clipboard makes the pending paste's bytes uncertain. It remains removable without guessing keys.
      for (const image of images) { const pending = context.pastes.get(image.id); if (pending && !pending.label) pending.conflicted = true; }
      onError(t('图片未发送。请在输入框中移除后重新粘贴。')); return;
    }
    const id = ++sequence.current, entry: Paste = {}, image: NativeImage = { id, src: '' }, intent = interaction.current;
    context.pastes.set(id, entry);
    setSnapshot(previous => ({ context, images: [...(previous.context === context ? previous.images : []), image] }));
    const retained = () => valid() && context.pastes.get(id) === entry;
    const canWrite = () => retained() && !entry.conflicted && interaction.current === intent && !blocked();
    const fail = () => { if (retained()) { discard(id); onError(t('图片未能附加，已从输入框移除。请等终端准备好后重新粘贴。')); } };
    const left = !images.length ? readInput()?.text ?? '' : '';
    const clearFirst = !!left && !inputImageLabels(left).length && !preserveDraft(left);
    const pressPaste = () => {
      if (!retained()) return;
      const current = readInput();
      if (!canWrite() || !current || clearFirst && current.text) { fail(); return; }
      entry.before = inputImageLabels(current.text);
      // Claude uses Alt+V only on Windows; macOS/Linux and Codex use Ctrl+V.
      window.agentrix.writeTerminal(terminalId, agent === 'claude' && isWindows ? '\x1bv' : '\x16');
      // Record any chip already visible; Send checks acceptance again after asynchronous CLI redraws.
      observe([...images, image]);
    };
    if (clearFirst) entry.ready = clearInput(canWrite).then(() => new Promise<void>(resolve => setTimeout(resolve, 60))).then(pressPaste);
    else pressPaste();
    void thumbnail(file).catch(() => dataUrl(file)).then(src => {
      if (retained()) setSnapshot(previous => previous.context === context ? { context, images: previous.images.map(image => image.id === id ? { ...image, src } : image) } : previous);
    }).catch(() => { if (retained()) onError(t('无法读取这张图片。')); });
  };
  const remove = async (index: number) => {
    if (sending.current || !valid()) return;
    const image = images[index];
    if (!image) return;
    if (!observe()) { discard(image.id); onError(t('已从输入框移除，请检查终端中是否还留有图片。')); return; }
    const current = readInput()!;
    const labels = inputImageLabels(current.text), removal = imageRemoval(agent, current.text, labels.length - images.length + index, current.rows.length);
    if (!removal) { onError(t('请在终端中检查并移除这张图片。')); return; }
    const intent = interaction.current, owns = () => valid() && interaction.current === intent && !blocked();
    sending.current = true;
    try {
      window.agentrix.writeTerminal(terminalId, removal.keys);
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 80));
        if (!owns()) return;
        const current = readInput();
        if (!current || JSON.stringify(inputImageLabels(current.text)) !== JSON.stringify(removal.labels)) continue;
        const kept = images.filter(item => item.id !== image.id), remaining = removal.labels.slice(-kept.length);
        kept.forEach((image, index) => { context.pastes.get(image.id)!.label = remaining[index]; });
        discard(image.id); return;
      }
      onError(t('请在终端中检查并移除这张图片。'));
    } catch (error) { if (owns()) onError(String(error)); }
    finally { if (valid() && interaction.current === intent) sending.current = false; }
  };
  return { images, clear, readInput, parsing, settle, dialogShown, awaitInput, clearInput, observe, paste, remove,
    prepare: (batch: readonly NativeImage[]) => Promise.all(batch.map(image => context.pastes.get(image.id)?.ready)),
    numbers: images.map((image, index) => Number(context.pastes.get(image.id)?.label?.match(/\d+/)?.[0] ?? index + 1)),
  };
}
