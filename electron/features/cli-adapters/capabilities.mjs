export const UNSUPPORTED = Object.freeze({
  screenReading: '请到终端里操作',
  screenImageRemoval: '请到终端里操作',
  terminal: '此 CLI 在 Agentrix 中不提供交互式终端会话。',
  native: '此 CLI 在 Agentrix 中不提供原生会话。',
  resume: '此 CLI 不支持续接会话。',
  roleTools: '此 CLI 不支持接入角色工具。',
  startupNote: '此 CLI 不支持注入启动说明。',
  messageNote: '此 CLI 不支持注入消息说明。',
  liveModel: '此 CLI 不支持在会话中切换模型。',
  liveEffort: '此 CLI 不支持在会话中切换深度。',
  fast: '此 CLI 不支持快速模式。',
  ultracode: '此 CLI 不支持 Ultracode。',
  permissionChoice: '此 CLI 不支持通过 Agentrix 的 /permissions 切换会话权限。',
  approvals: '此 CLI 不支持处理确认请求。',
  transcript: '此 CLI 不提供可读的会话记录。',
  accountLimits: '此 CLI 不提供可读的账号额度。',
  tokenRate: '此 CLI 不提供计算输出速率所需的数据。',
  subagents: '此 CLI 不提供子代理事件。',
  readOnlyRole: '此 CLI 不支持只读角色。',
  writableRole: '此 CLI 不支持可写角色。',
  'ssh.terminal': '此 CLI 在 Agentrix 中不提供 SSH 交互式终端会话。',
  'ssh.native': '此 CLI 在 Agentrix 中不提供 SSH 原生会话。',
});

export const CAPABILITY_KEYS = Object.freeze(Object.keys(UNSUPPORTED));
export const UNVERIFIED_VERSION = '未验证的 {cli} 版本。';
const UNKNOWN_CAPABILITY = '此 CLI 不支持这项能力。';

// Screen compatibility is verified against specific stable releases. Build metadata leaves their ordering intact.
function versionParts(version) {
  if (typeof version !== 'string') return null;
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version)?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : null;
}

function compareVersion(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function belowMinimum(version, minimum) {
  const actual = versionParts(version.split('-')[0]), lower = versionParts(minimum);
  return !!(actual && lower && compareVersion(actual, lower) < 0);
}

// 'older' is refused. 'newer' is tried: the CLI updates itself almost daily, and a failed switch already reports itself.
function verifiedVersion(version, [min, max]) {
  const actual = versionParts(version), lower = versionParts(min), upper = versionParts(max);
  if (!actual || !lower || !upper || compareVersion(actual, lower) < 0) return 'older';
  return compareVersion(actual, upper) > 0 ? 'newer' : 'verified';
}

export function support(manifest, key, version) {
  const capability = Object.hasOwn(manifest.supports, key) ? manifest.supports[key] : undefined;
  if (capability === true) return { ok: true };
  if (capability?.unsupported) return { ok: false, reason: capability.unsupported };
  if (!capability) return { ok: false, reason: Object.hasOwn(UNSUPPORTED, key) ? UNSUPPORTED[key] : UNKNOWN_CAPABILITY };
  const verified = version != null && capability.verified ? verifiedVersion(version, capability.verified) : 'verified';
  if (verified === 'older') return { ok: false, reason: UNVERIFIED_VERSION, params: { cli: manifest.label } };
  return { ok: true, via: capability.via, ...(verified === 'newer' ? { unverified: true } : {}) };
}
