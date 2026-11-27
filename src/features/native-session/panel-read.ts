// A send receipt's answer as a panel, by the provider that gave it; null when the receipt answers nothing.
import { claudePanel } from './panel-claude.ts';
import { codexPanel } from './panel-codex.ts';
import { localOf, type Panel, type PanelAgent } from './native-panel.ts';

const readByAgent: Partial<Record<PanelAgent, typeof codexPanel>> = { codex: codexPanel, claude: claudePanel };

export function readPanel(agent: PanelAgent, receipt: unknown, now = Date.now()): Panel | null {
  return readByAgent[agent]?.(localOf(receipt), now) ?? null;
}
