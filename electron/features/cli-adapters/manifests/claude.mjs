import { UNSUPPORTED } from '../capabilities.mjs';

// The repository has captured picker rows from 2.1.331. Keep the screen range pinned until more releases are checked.
const liveScreen = { via: 'screen', verified: ['2.1.317', '2.1.331'] };
const subcommands = ['update', 'upgrade', 'install', 'migrate-installer', 'doctor', 'mcp', 'config', 'plugin', 'setup-token', 'login', 'logout', 'auth'];
const harmless = ['--version', '-v', '--help', '-h'];
const versionHelp = [...harmless, '-V'];
const print = ['-p', '--print'];

export default Object.freeze({
  id: 'claude', label: 'Claude Code', shortLabel: 'Claude', command: 'claude',
  brand: 'anthropic',
  usage: { label: 'Claude', showUnavailable: true, apiSpend: true, provider: 'Anthropic', inputExcludesCache: true },
  install: {
    npm: '@anthropic-ai/claude-code', page: 'https://code.claude.com/docs/en/setup', diagnostics: 'split-install',
    versionPattern: /\b(\d+)\.(\d+)\.(\d+)\b/, minVersion: '2.1.317', label: 'Claude Code',
  },
  models: {
    match: /^(opus|sonnet|haiku|fable|claude-)/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], ultracodeLead: true,
    prefix: '', fallback: 'opus', preferred: null, fastDefault: false,
    fastNotes: { billing: '快速模式可能按不同价格计费（例如 Opus 快速）', retry: 'Claude Code 上次拒绝了快速模式，再点一次可重试' },
    fileEfforts: ['adaptive'], catalogAge: { startup: null, dialog: 24 * 3600000, manual: 0 }, aliases: ['opus', 'sonnet', 'haiku'],
  },
  words: {
    utilities: [...subcommands, ...versionHelp, ...print], harmless, print, subcommands, versionHelp,
    welcome: ['/init', '/help', '/status', '/review'],
  },
  supports: {
    screenReading: { via: 'screen', verified: ['2.1.293', '2.1.331'] },
    screenImageRemoval: { via: 'screen', verified: ['2.1.312', '2.1.312'] },
    terminal: { via: 'arg' }, native: { via: 'api' }, resume: { via: 'arg' }, roleTools: { via: 'arg' },
    startupNote: { via: 'arg' }, messageNote: { via: 'hook' },
    liveModel: liveScreen, liveEffort: liveScreen, fast: liveScreen, ultracode: liveScreen,
    permissionChoice: { unsupported: UNSUPPORTED.permissionChoice }, approvals: { via: 'screen' },
    transcript: { via: 'hook' }, accountLimits: { via: 'api' }, tokenRate: { via: 'api' }, subagents: { via: 'hook' },
    readOnlyRole: { via: 'arg' }, writableRole: { via: 'arg' },
    'ssh.terminal': { via: 'arg' }, 'ssh.native': { unsupported: UNSUPPORTED['ssh.native'] },
  },
});
