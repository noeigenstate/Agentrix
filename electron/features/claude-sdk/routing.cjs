const fs = require('node:fs');
const path = require('node:path');
const { routeFailure } = require('./identity.cjs');

// Flag settings override disk env without disabling the owner's project hooks and permissions.
const ROUTE_ENV = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_MANTLE_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'GLOBAL_AGENT_HTTP_PROXY', 'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'AWS_CA_BUNDLE', 'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'CLAUDE_CODE_API_BASE_URL', 'CLAUDE_BRIDGE_BASE_URL', 'CLAUDE_RUNNER_API_BASE_URL',
  'CLAUDE_CODE_HTTP_PROXY', 'CLAUDE_CODE_HTTPS_PROXY', 'CLAUDE_CODE_PROXY_URL', 'CLAUDE_CODE_PROXY_HOST',
  'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY', 'GRPC_PROXY', 'HTTPLIB2_CA_CERTS', 'SSLKEYLOGFILE',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_ARTIFACTS_API_BASE_URL', 'CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL', 'CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL',
  'CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL', 'CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL', 'CLAUDE_CODE_MEMORY_API_BASE_URL', 'CLAUDE_CODE_GB_BASE_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];
const routeName = name => ROUTE_ENV.includes(name.toUpperCase()) || /^(?:ANTHROPIC_|CLAUDE_CODE_USE_)|(?:BASE_URL|PROXY|ENDPOINT|CA_CERT|CA_BUNDLE|CERT_STORE|CLIENT_CERT|CLIENT_KEY|GATEWAY|TLS_)/i.test(name);
const HELPERS = ['apiKeyHelper', 'proxyAuthHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh'];
// These CA search paths change default trust discovery when set to an empty string. Pin them only when needed.
const conditionalRoute = name => /^(?:SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|HTTPLIB2_CA_CERTS|AWS_.*)$/.test(name);
const SETTINGS_LIMIT = 64 * 1024 * 1024;
function settings(file, project = false) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size > SETTINGS_LIMIT) throw Object.assign(new Error(), { code: 'settings_too_large' });
    const bytes = Buffer.alloc(size + 1);
    let length = 0, read;
    while (length < bytes.length && (read = fs.readSync(fd, bytes, length, bytes.length - length, length))) length += read;
    if (length > SETTINGS_LIMIT) throw Object.assign(new Error(), { code: 'settings_too_large' });
    const raw = bytes.subarray(0, length), utf16 = raw[0] === 0xff && raw[1] === 0xfe;
    const value = JSON.parse(raw.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (project && error.code !== 'settings_too_large') return null;
    throw routeFailure('route_config_unreadable', file);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function routeSettings(spec) {
  const cwd = path.resolve(spec.cwd || process.cwd()), root = path.resolve(spec.worktree || spec.projectRoot || cwd);
  const inherited = spec.env || process.env;
  const home = process.platform === 'win32' ? inherited.USERPROFILE || inherited.HOME : inherited.HOME || inherited.USERPROFILE;
  const config = inherited.CLAUDE_CONFIG_DIR || (home ? path.join(home, '.claude') : null);
  let user = {};
  if (spec.owner !== 'dispatch' && config) {
    const file = path.join(config, 'settings.json');
    // A user-config junction into the repository is still project-controlled.
    let real; try { real = fs.realpathSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const relative = real && path.relative(root, real);
    if (real && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) user = settings(file) || {};
  }
  const trusted = new Map(Object.entries({ ...inherited, ...(user.env || {}) }).map(([name, value]) => [name.toUpperCase(), value]));
  const names = new Set(ROUTE_ENV.filter(name => !conditionalRoute(name)));
  // Cover mixed-case spellings and newly added transport variables from every project settings source.
  for (let folder = cwd; spec.owner !== 'dispatch' && (folder === root || folder.startsWith(root + path.sep)); folder = path.dirname(folder)) {
    for (const filename of ['settings.json', 'settings.local.json']) {
      const file = path.join(folder, '.claude', filename), config = settings(file, true);
      // A parser mismatch must not remove route protection; malformed files still let the CLI start.
      if (!config) { for (const name of ROUTE_ENV) names.add(name); continue; }
      const env = config.env;
      if (Object.keys(env || {}).some(name => name.toUpperCase() === 'ANTHROPIC_API_KEY')) {
        throw routeFailure('project_api_key_override', path.relative(cwd, file).split(path.sep).join('/'));
      }
      for (const name of Object.keys(env || {})) if (routeName(name)) names.add(name);
    }
    if (folder === root) break;
  }
  const env = {};
  for (const name of names) {
    const canonical = name.toUpperCase();
    // The saved key remains solely in the child environment, never in a settings file or CLI arguments.
    if (canonical === 'ANTHROPIC_API_KEY') continue;
    const value = canonical === 'ANTHROPIC_AUTH_TOKEN' ? ''
      : /^CLAUDE_CODE_USE_/i.test(name) ? '0' : trusted.get(canonical) ?? (canonical === 'ANTHROPIC_BASE_URL' ? 'https://api.anthropic.com' : '');
    for (const variant of [name, canonical, name.toLowerCase()]) env[variant] = typeof value === 'string' ? value : '';
  }
  return { env, ...Object.fromEntries(HELPERS.map(name => [name, typeof user[name] === 'string' ? user[name] : ''])) };
}
module.exports = { routeSettings, ROUTE_ENV, routeName };
