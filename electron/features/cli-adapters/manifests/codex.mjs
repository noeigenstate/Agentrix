import { UNSUPPORTED } from '../capabilities.mjs';

const harmless = ['--version', '-V', '--help', '-h', 'help'];

export default Object.freeze({
  id: 'codex', label: 'Codex', shortLabel: 'Codex', command: 'codex',
  brand: 'openai',
  usage: { resetCredits: true },
  install: {
    npm: '@openai/codex', page: 'https://learn.chatgpt.com/docs/codex/cli', diagnostics: 'drive-scan',
    versionPattern: /\b\d+\.\d+\.\d+(?:-[\w.]+)?/, minVersion: '0.166.0', label: 'Codex CLI',
  },
  // Keep this catch-all after the specific model rules.
  models: {
    match: /^/, efforts: ['low', 'medium', 'high', 'xhigh'], ultracodeLead: false,
    prefix: '', fallback: 'gpt-6.1-sol', preferred: /^gpt-(\d+)(?:\.(\d+))?-sol$/, fastDefault: true,
    defaultRoles: ['developer', 'devops'],
    fileEfforts: ['minimal', 'max', 'ultra'], catalogAge: { startup: 6 * 3600000, dialog: 3600000, manual: 0 }, aliases: [],
  },
  words: {
    utilities: [...harmless, 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion',
      'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'features'],
    harmless, print: ['exec', 'e'], welcome: ['/init', '/status', '/review', '/permissions'],
    nativeRejected: ['upgrade', 'mcp-server', 'review', 'cloud', 'fork', 'agents', 'queue'],
  },
  supports: {
    screenReading: { via: 'screen', verified: ['0.161.0', '0.166.0'] },
    screenImageRemoval: { via: 'screen', verified: ['0.165.0', '0.165.0'] },
    terminal: { unsupported: UNSUPPORTED.terminal }, native: { via: 'api' }, resume: { via: 'api' }, roleTools: { via: 'api' },
    startupNote: { via: 'api' }, messageNote: { via: 'api' }, liveModel: { via: 'api' }, liveEffort: { via: 'api' }, fast: { via: 'api' },
    ultracode: { unsupported: UNSUPPORTED.ultracode }, permissionChoice: { via: 'api' }, approvals: { via: 'api' },
    transcript: { via: 'api' }, accountLimits: { via: 'api' }, tokenRate: { via: 'api' }, subagents: { via: 'api' },
    readOnlyRole: { via: 'api' }, writableRole: { via: 'api' },
    'ssh.terminal': { unsupported: UNSUPPORTED['ssh.terminal'] }, 'ssh.native': { via: 'api' },
  },
});
