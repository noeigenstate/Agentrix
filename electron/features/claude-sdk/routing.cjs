const fs = require('node:fs');
const path = require('node:path');

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
function settings(file) {
  try {
    if (fs.statSync(file).size > 1048576) throw new Error('settings_too_large');
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取 Claude 路由配置。'); }
}
function routeSettings(spec) {
  const cwd = path.resolve(spec.cwd || process.cwd()), root = path.resolve(spec.worktree || spec.projectRoot || cwd);
  const inherited = spec.env || process.env;
  const config = inherited.CLAUDE_CONFIG_DIR || (inherited.HOME || inherited.USERPROFILE ? path.join(inherited.HOME || inherited.USERPROFILE, '.claude') : null);
  let user = {};
  if (spec.owner !== 'dispatch' && config) {
    const file = path.join(config, 'settings.json');
    // A user-config junction into the repository is still project-controlled.
    let real; try { real = fs.realpathSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const relative = real && path.relative(root, real);
    if (real && (relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) user = settings(file);
  }
  const trusted = new Map(Object.entries({ ...inherited, ...(user.env || {}) }).map(([name, value]) => [name.toUpperCase(), value]));
  const names = new Set(ROUTE_ENV);
  for (const name of [...Object.keys(inherited), ...Object.keys(user.env || {})]) if (routeName(name)) names.add(name);
  // Cover mixed-case spellings and newly added transport variables from every project settings source.
  for (let folder = cwd; folder === root || folder.startsWith(root + path.sep); folder = path.dirname(folder)) {
    for (const filename of ['settings.json', 'settings.local.json']) {
      const env = settings(path.join(folder, '.claude', filename)).env;
      for (const name of Object.keys(env || {})) if (routeName(name)) names.add(name);
    }
    if (folder === root) break;
  }
  const env = {};
  for (const name of names) {
    const canonical = name.toUpperCase();
    // Settings become CLI arguments. The saved key must remain solely in the child environment.
    if (canonical === 'ANTHROPIC_API_KEY') continue;
    const value = canonical === 'ANTHROPIC_AUTH_TOKEN' ? ''
      : /^CLAUDE_CODE_USE_/i.test(name) ? '0' : trusted.get(canonical) ?? (canonical === 'ANTHROPIC_BASE_URL' ? 'https://api.anthropic.com' : '');
    for (const variant of [name, canonical, name.toLowerCase()]) env[variant] = typeof value === 'string' ? value : '';
  }
  return { env, ...Object.fromEntries(HELPERS.map(name => [name, typeof user[name] === 'string' ? user[name] : ''])) };
}
module.exports = { routeSettings, ROUTE_ENV, routeName };
