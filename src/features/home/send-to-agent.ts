import { parseAgentScreen } from '../agents/agent-screen';
import { cliDialogShown, cliInputDraft, hasCliInput, isAtPrompt } from '../reading/cli-panel';
import { readScreen } from '../terminal/terminal-screen';
import { sameMessage } from '../reading/pending-prompts';
import { t } from '../../shared/i18n';

type Agent = 'claude' | 'codex';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// What the agent's screen holds now: null while its terminal has none (not drawn yet).
function look(terminalId: string, agent: Agent) {
  const rows = readScreen(terminalId)?.rows;
  return rows ? { rows, screen: parseAgentScreen(agent, rows) } : null;
}

// Both CLIs queue messages while working if their input is drawn. Dialogs own the keys. Owner sends replace an old
// draft; background relays preserve it and press Enter only while their own message is still in the input.
export async function sendToAgent(terminalId: string, sessionId: string, agent: Agent, text: string,
  { preserveDraft = false }: { preserveDraft?: boolean } = {}): Promise<string | null> {
  const screenError = t('请先在终端中处理当前界面，再发送消息。');
  const draftError = t('规划员输入框中有未发送的草稿，请先处理草稿后重试。');
  const now = look(terminalId, agent);
  if (!now) return t('它的终端还没有准备好，请稍后再试。');
  if (cliDialogShown(agent, now.rows, now.screen) || !hasCliInput(agent, now.rows, now.screen)) return screenError;
  if (cliInputDraft(agent, now.rows, now.screen)) {
    if (preserveDraft) return draftError;
    window.agentrix.writeTerminal(terminalId, '\x15'); await pause(60);
  }
  const pasted = await window.agentrix.pasteTerminal(terminalId, text, sessionId);
  if (!pasted.ok) return pasted.error;
  for (let attempt = 0; attempt < 3; attempt++) {
    await pause(attempt === 0 ? 400 : 700);
    const after = look(terminalId, agent);
    if (preserveDraft && (!after || cliDialogShown(agent, after.rows, after.screen) || !hasCliInput(agent, after.rows, after.screen))) return screenError;
    const draft = after ? cliInputDraft(agent, after.rows, after.screen) : '';
    if (!sameMessage(text, draft)) {
      if (preserveDraft && draft) return draftError;
      if (preserveDraft || attempt > 0) break;
    }
    window.agentrix.writeTerminal(terminalId, '\r');
  }
  return null;
}

// Waits until a just-started agent shows its input (it may first ask to trust the folder or to sign in, which the
// decision page takes). Gives whether it got there within the time.
export async function untilAtPrompt(terminalId: string, agent: Agent, timeout = 45000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(400)) {
    const now = look(terminalId, agent);
    if (now && !now.screen.choice && isAtPrompt(agent, now.rows, now.screen)) return true;
  }
  return false;
}

// Whether the agent waits at its input right now (not working, not asking).
export function atPrompt(terminalId: string, agent: Agent) {
  const now = look(terminalId, agent);
  return !!now && isAtPrompt(agent, now.rows, now.screen);
}
