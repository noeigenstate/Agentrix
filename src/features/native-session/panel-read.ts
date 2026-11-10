// A send receipt's answer as a panel, by the provider that gave it; null when the receipt answers nothing.
import { claudePanel } from './panel-claude.ts';
import { codexPanel } from './panel-codex.ts';
import { localOf, type Panel, type PanelAgent } from './native-panel.ts';

export function readPanel(agent: PanelAgent, receipt: unknown, now = Date.now()): Panel | null {
  const local = localOf(receipt);
  return agent === 'codex' ? codexPanel(local, now) : claudePanel(local, now);
}
