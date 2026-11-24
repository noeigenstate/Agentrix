import { UNSUPPORTED } from '../capabilities.mjs';

// The repository has captured picker rows from 2.1.331. Keep the screen range pinned until more releases are checked.
const liveScreen = { via: 'screen', verified: ['2.1.331', '2.1.331'] };

export default Object.freeze({
  id: 'claude', label: 'Claude Code', command: 'claude',
  install: { npm: '@anthropic-ai/claude-code', versionPattern: /\b(\d+)\.(\d+)\.(\d+)\b/, minVersion: '2.1.317', label: 'Claude Code' },
  models: { match: /^(opus|sonnet|haiku|fable|claude-)/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], ultracodeLead: true },
  words: {
    utilities: ['update', 'upgrade', 'install', 'migrate-installer', 'doctor', 'mcp', 'config', 'plugin', 'setup-token', 'login', 'logout', 'auth',
      '--version', '-v', '-V', '--help', '-h', '-p', '--print'],
    harmless: ['--version', '-v', '--help', '-h'],
    print: ['-p', '--print'],
  },
  supports: {
    terminal: { via: 'arg' }, native: { via: 'api' }, resume: { via: 'arg' }, roleTools: { via: 'arg' },
    startupNote: { via: 'arg' }, messageNote: { via: 'hook' },
    liveModel: liveScreen, liveEffort: liveScreen, fast: liveScreen, ultracode: liveScreen,
    permissionChoice: { unsupported: UNSUPPORTED.permissionChoice }, approvals: { via: 'screen' },
    transcript: { via: 'hook' }, accountLimits: { via: 'api' }, tokenRate: { via: 'api' }, subagents: { via: 'hook' },
    readOnlyRole: { via: 'arg' }, writableRole: { via: 'arg' },
    'ssh.terminal': { via: 'arg' }, 'ssh.native': { unsupported: UNSUPPORTED['ssh.native'] },
  },
});
