import type { Terminal } from '@xterm/xterm';
import { choiceIdentity, parseAgentScreen } from './agent-screen.ts';
import type { WorkerMenuFrame, WorkerScreenPacket } from '../../shared/types';

export function parseWorkerMenu(rows: string[]): WorkerMenuFrame | null {
  const choice = parseAgentScreen('claude', rows).choice;
  if (!choice || choice.kind === 'menu') return null;
  const { title, options, question } = choice;
  const kind = title === 'Exit plan mode?' ? 'plan' : choice.kind;
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

export function observeWorkerMenus(bridge: Pick<Window['agentrix'], 'onWorkerScreen' | 'reportWorkerMenu'>, createTerminal: (cols: number, rows: number) => Terminal) {
  const screens = new Map<string, { terminal: Terminal; seq: number }>();
  return bridge.onWorkerScreen((packet: WorkerScreenPacket) => {
    const { epoch, seq, cols, rows, data } = packet;
    let screen = screens.get(epoch);
    if (packet.exited || screen && seq !== screen.seq + 1) {
      screen?.terminal.dispose();
      screens.delete(epoch);
      return;
    }
    if (!screen) {
      if (seq !== 1) return;
      const terminal = createTerminal(cols, rows);
      screen = { terminal, seq: 0 };
      screens.set(epoch, screen);
    }
    const { terminal } = screen;
    screen.seq = seq;
    if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
    terminal.write(data, () => {
      if (screens.get(epoch)?.seq !== seq) return;
      const buffer = terminal.buffer.active;
      const lines = Array.from({ length: rows }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '');
      bridge.reportWorkerMenu(epoch, seq, parseWorkerMenu(lines));
    });
  });
}
