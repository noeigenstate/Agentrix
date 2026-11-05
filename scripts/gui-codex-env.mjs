import { fileURLToPath } from 'node:url';
export const guiCodexEnvironment = () => ({ AGENTRIX_FAKE_NODE: process.execPath,
  AGENTRIX_GUI_CODEX_RPC: fileURLToPath(new URL('../tests/fixtures/gui-codex-app-server.cjs', import.meta.url)) });
