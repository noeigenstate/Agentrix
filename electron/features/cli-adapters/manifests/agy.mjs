import { CAPABILITY_KEYS, UNSUPPORTED } from '../capabilities.mjs';

const api = new Set(['native', 'resume', 'liveModel', 'liveEffort', 'transcript', 'roleTools', 'startupNote', 'messageNote',
  'approvals', 'readOnlyRole', 'writableRole', 'accountLimits', 'ssh.native']);

export default Object.freeze({
  id: 'agy', label: 'Antigravity', shortLabel: 'agy', command: 'agy', brand: 'antigravity',
  usage: { provider: 'Google Antigravity', inputExcludesCache: true, quotaUnavailable: '暂时读不到 agy 的额度（未登录或版本过低时会这样）。' },
  install: {
    page: 'https://antigravity.google/docs/getting-started?tab=cli',
    commands: { windows: 'irm https://antigravity.google/cli/install.ps1 | iex', unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    versionPattern: /\b\d+\.\d+\.\d+\b/, minVersion: '1.5.18', label: 'Antigravity CLI',
  },
  models: {
    match: /^(agy:|gemini-)/, prefix: 'agy:', efforts: ['low', 'medium', 'high', 'xhigh', 'default'], ultracodeLead: false,
    fallback: null, preferred: null, fastDefault: false, fileEfforts: [], aliases: [],
    catalogAge: { startup: null, dialog: 3600000, manual: 0 }, catalogBackground: true, remoteCatalog: true,
  },
  words: { bareNative: true, utilities: ['--version', '-v', '--help', '-h', 'help'] },
  supports: Object.fromEntries(CAPABILITY_KEYS.map(key => [key, api.has(key) ? { via: 'api' } : { unsupported: UNSUPPORTED[key] }])),
});
