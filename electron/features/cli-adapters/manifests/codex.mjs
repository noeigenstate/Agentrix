import { UNSUPPORTED } from '../capabilities.mjs';

const harmless = ['--version', '-V', '--help', '-h', 'help'];

export default Object.freeze({
  id: 'codex', label: 'Codex', command: 'codex',
  usage: { resetCredits: true },
  install: { npm: '@openai/codex', versionPattern: /\b\d+\.\d+\.\d+(?:-[\w.]+)?/, minVersion: '0.166.0', label: 'Codex CLI' },
  // Keep this catch-all after the specific model rules.
  models: { match: /^/, efforts: ['low', 'medium', 'high', 'xhigh'], ultracodeLead: false },
  words: {
    utilities: [...harmless, 'login', 'logout', 'mcp', 'plugin', 'app-server', 'remote-control', 'app', 'completion',
      'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive', 'migrate-rollouts', 'migrate-nfs-db', 'exec-server', 'features'],
    harmless, print: ['exec', 'e'], welcome: ['/init', '/status', '/review', '/permissions'],
    nativeRejected: ['upgrade', 'mcp-server', 'review', 'cloud', 'fork', 'agents', 'queue'],
  },
  supports: {
    terminal: { unsupported: UNSUPPORTED.terminal }, native: { via: 'api' }, resume: { via: 'api' }, roleTools: { via: 'api' },
    startupNote: { via: 'api' }, messageNote: { via: 'api' }, liveModel: { via: 'api' }, liveEffort: { via: 'api' }, fast: { via: 'api' },
    ultracode: { unsupported: UNSUPPORTED.ultracode }, permissionChoice: { via: 'api' }, approvals: { via: 'api' },
    transcript: { via: 'api' }, accountLimits: { via: 'api' }, tokenRate: { via: 'api' }, subagents: { via: 'api' },
    readOnlyRole: { via: 'api' }, writableRole: { via: 'api' },
    'ssh.terminal': { unsupported: UNSUPPORTED['ssh.terminal'] }, 'ssh.native': { via: 'api' },
  },
});
