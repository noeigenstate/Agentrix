// Claude's terminal-only utility commands. Codex shell commands request a
// native app-server session instead, using codexLaunch below.
const COMMANDS = {
  claude: ['update', 'upgrade', 'install', 'migrate-installer', 'doctor', 'mcp', 'config', 'plugin', 'setup-token', 'login', 'logout', 'auth',
    '--version', '-v', '-V', '--help', '-h', '-p', '--print'],
};

// The command when this run is one of these, else null (a conversation, new or resumed).
function agentCommand(agent, word) {
  if (agent !== 'claude') return null;
  if (typeof word !== 'string' || !/^-{0,2}[A-Za-z][A-Za-z-]{0,23}$/.test(word)) return null;
  return COMMANDS.claude.includes(word) ? word : null;
}

// This is a request from Agentrix's authenticated shell wrapper, not an argv
// escape hatch into app-server. Reject unsupported semantics without echoing
// possible credentials or quietly changing what the owner asked to run.
function codexLaunch(args) {
  const fail = () => { throw new Error('Agentrix 内的 Codex 仅使用原生模式；此命令或参数暂不支持，请在软件外的终端运行。'); };
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.includes('\0')) || JSON.stringify(args).length > 32768) fail();
  const result = { resume: false }, seen = new Set();
  const set = (key, value) => { if (seen.has(key) || !value) fail(); seen.add(key); result[key] = value; };
  const commands = new Set(['update', 'upgrade', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'app', 'completion', 'debug', 'apply', 'a', 'exec', 'e', 'review', 'sandbox', 'cloud', 'features', 'doctor', 'help', 'fork']);
  for (let i = 0; i < args.length; i++) {
    const word = args[i], equals = word.indexOf('='), option = equals < 0 ? word : word.slice(0, equals);
    const value = () => equals < 0 ? args[++i] : word.slice(equals + 1);
    if (word === 'resume' && !seen.has('prompt')) {
      if (result.resume) fail();
      result.resume = true;
      const identity = args[++i];
      if (identity === '--last') result.latest = true;
      else {
        if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(identity || '')) fail();
        result.providerSessionId = identity;
      }
    } else if (['-m', '--model'].includes(option)) {
      set('model', value());
    } else if (['-C', '--cd'].includes(option)) set('cwd', value());
    else if (['-c', '--config'].includes(option)) {
      const match = /^(model|model_reasoning_effort|service_tier)=(?:"([^"\r\n]+)"|([^"\r\n]+))$/.exec(value() || '');
      if (!match) fail();
      const key = { model: 'model', model_reasoning_effort: 'effort', service_tier: 'fast' }[match[1]], setting = match[2] || match[3];
      if (key === 'effort' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(setting) || key === 'fast' && setting !== 'fast') fail();
      set(key, key === 'fast' ? true : setting);
    } else if (word === '--') { if (i !== args.length - 2) fail(); set('prompt', args[++i]); }
    else { if (word.startsWith('-') || commands.has(word)) fail(); set('prompt', word); }
  }
  if (result.model?.length > 160 || result.cwd?.length > 4096) fail();
  return result;
}

module.exports = { agentCommand, codexLaunch };
