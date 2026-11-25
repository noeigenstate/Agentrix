import type { Terminal } from '@xterm/xterm';
import { choiceIdentity, parseAgentScreen } from './agent-screen.ts';
import { screenOf, type ScreenAgent } from '../cli-screens/index.ts';
import type { WorkerMenuFrame, WorkerScreenPacket } from '../../shared/types';

// The main process currently emits this stream only for interactive Claude workers.
const hiddenWorkerAgent: ScreenAgent = 'claude';
export function parseWorkerMenu(rows: string[], agent: ScreenAgent = hiddenWorkerAgent, version?: string): WorkerMenuFrame | null {
  const choice = parseAgentScreen(agent, rows, version).choice;
  if (!choice || choice.kind === 'menu') return null;
  const { title, options, question } = choice;
  const kind = screenOf(agent)?.workerPlan?.(choice) ? 'plan' : choice.kind;
  const cursors = options.filter(option => option.selected);
  const selected = cursors.length === 1 ? cursors[0] : null;
  if (options.length > 20 || title.length > 512 || options.some(option => option.label.length > 512)) return null;
  // A multi-select or a focused custom-input row is reportable, but its keys have a different meaning.
  const navigable = !!selected && (kind !== 'question' || !question?.multi && selected.role === 'answer');
  const identity = choiceIdentity(choice);
  if (identity.length > 8192) return null;
  return { kind, title, identity, selected: selected?.number ?? null, navigable,
    options: options.map(({ number, label, role }) => ({ number, label, role })) };
}

const IDLE_MS = 5 * 60_000;
type Screen = { terminal?: Terminal; seq: number; version?: string; last: WorkerScreenPacket; touched: number; recovering: boolean };

export function observeWorkerMenus(bridge: Pick<Window['agentrix'], 'onWorkerScreen' | 'workerScreenSnapshot' | 'reportWorkerMenu'>,
  createTerminal: (cols: number, rows: number) => Terminal) {
  const screens = new Map<string, Screen>();
  const remove = (epoch: string) => {
    screens.get(epoch)?.terminal?.dispose();
    screens.delete(epoch);
  };
  const apply = (screen: Screen, packet: WorkerScreenPacket) => {
    const { epoch, seq, cols, rows, data } = packet;
    const terminal = screen.terminal ??= createTerminal(cols, rows);
    screen.seq = seq;
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
    terminal.write(data, () => {
      if (screens.get(epoch) !== screen || screen.terminal !== terminal || screen.last.seq !== seq) return;
      const buffer = terminal.buffer.active;
      const lines = Array.from({ length: rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '');
      screen.version ??= screenOf(hiddenWorkerAgent)?.version?.(lines);
      bridge.reportWorkerMenu(epoch, seq, parseWorkerMenu(lines, hiddenWorkerAgent, screen.version));
    });
  };
  const recover = async (epoch: string, screen: Screen) => {
    screen.recovering = true;
    const requested = screen.last.seq;
    const result = await bridge.workerScreenSnapshot(epoch).catch(() => null);
    if (screens.get(epoch) !== screen) return;
    screen.recovering = false;
    const snapshot = result?.ok ? result.value : null;
    if (snapshot?.epoch === epoch && !snapshot.exited && snapshot.seq >= requested) {
      if (snapshot.seq >= screen.last.seq) {
        screen.last = snapshot;
        apply(screen, snapshot);
        return;
      }
      if (snapshot.seq + 1 === screen.last.seq && !screen.last.snapshotRequired) {
        apply(screen, snapshot);
        apply(screen, screen.last);
        return;
      }
    }
    if (screen.last.seq > requested) void recover(epoch, screen);
  };
  const off = bridge.onWorkerScreen(packet => {
    const { epoch, seq } = packet;
    if (packet.exited) { remove(epoch); return; }
    let screen = screens.get(epoch);
    if (screen && seq <= screen.last.seq) return;
    screen ??= { seq: 0, last: packet, touched: 0, recovering: false };
    screens.set(epoch, screen);
    screen.last = packet;
    screen.touched = Date.now();
    if (screen.recovering) return;
    if (!packet.snapshotRequired && seq === screen.seq + 1 && (screen.terminal || seq === 1)) { apply(screen, packet); return; }
    screen.terminal?.dispose();
    screen.terminal = undefined;
    void recover(epoch, screen);
  });
  const timer = setInterval(() => {
    const deadline = Date.now() - IDLE_MS;
    for (const [epoch, screen] of screens) if (screen.touched <= deadline) remove(epoch);
  }, IDLE_MS);
  return () => { off(); clearInterval(timer); for (const epoch of screens.keys()) remove(epoch); };
}
