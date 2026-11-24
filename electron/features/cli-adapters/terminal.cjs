// The portable form also travels in the existing SSH launcher envelope. Keep it free of host dependencies.
const claudeWire = {
  // Local MCP comes first. The SSH wrapper has always put MCP after the seat.
  localOrder: ['roleTools', 'settings', 'note', 'model', 'effort', 'resume'],
  remoteOrder: ['settings', 'note', 'model', 'effort', 'resume', 'roleTools'],
  flags: { settings: '--settings', note: '--append-system-prompt', model: '--model', effort: '--effort', resume: '--resume' },
  roleTools: { prefix: '--mcp-config=', table: 'mcpServers', name: 'agentrix', type: 'stdio' },
  note: { marker: ' Agentrix skill delivery: ', suffix: ' Agentrix delivers skill instructions through its SessionStart hook.' },
  overrides: ['--model', '--effort'],
};

const nativeCommands = ['resume', 'fork'];
const rootValues = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);

function codexCommand(argv) {
  let index = 0;
  while (index < argv.length && /^-./.test(argv[index]) && argv[index] !== '--') {
    index += !argv[index].includes('=') && rootValues.has(argv[index]) ? 2 : 1;
  }
  return argv[index];
}

const beforeSeparator = argv => argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length);
const startupNote = note => note?.includes(claudeWire.note.marker) ? note.split(claudeWire.note.marker, 1)[0] + claudeWire.note.suffix : note;
const claudeConfig = server => {
  const { table, name, type } = claudeWire.roleTools;
  return { [table]: { [name]: { type, ...server } } };
};
const claudeRoleTools = { config: claudeConfig, args: server => [claudeWire.roleTools.prefix + JSON.stringify(claudeConfig(server))], lead: true };
const codexRoleTools = {
  config: server => ({ mcp_servers: { agentrix: server } }),
  args: ({ command, args, env }) => ['-c', `mcp_servers.agentrix.command=${JSON.stringify(command)}`, '-c', `mcp_servers.agentrix.args=${JSON.stringify(args)}`,
    '-c', `mcp_servers.agentrix.env={${Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(', ')}}`],
};

function claudeLaunch({ resume, seat, note, roleServer, roleTools = roleServer ? claudeRoleTools.args(roleServer) : [], hooks, roleError, remote = false, env = [] }) {
  let startup = startupNote(note) || '';
  if (roleError && !startup.includes(roleError)) startup = startup ? roleError + ' ' + startup : roleError;
  const values = { settings: hooks?.file, note: startup, model: seat?.model, effort: seat?.effort, resume };
  const order = remote ? claudeWire.remoteOrder : claudeWire.localOrder;
  const argv = order.flatMap(field => field === 'roleTools' ? roleTools : values[field] ? [claudeWire.flags[field], values[field]] : []);
  return { argv, env };
}

function codexLaunch(args, words, routingOwned) {
  const fail = () => { throw new Error('Agentrix 内的 Codex 仅使用原生模式；此命令或参数暂不支持，请在软件外的终端运行。'); };
  if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.includes('\0')) || JSON.stringify(args).length > 32768) fail();
  const result = { resume: false }, seen = new Set();
  const set = (key, value) => { if (seen.has(key) || !value) fail(); seen.add(key); result[key] = value; };
  const commands = new Set([...words.utilities, ...words.print, ...words.nativeRejected]);
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
    } else if (['-m', '--model'].includes(option)) throw routingOwned();
    else if (['-C', '--cd'].includes(option)) set('cwd', value());
    else if (['-c', '--config'].includes(option)) {
      if (/^\s*(model|model_reasoning_effort|service_tier)\s*=/.test(value() || '')) throw routingOwned();
      fail();
    } else if (word === '--') { if (i !== args.length - 2) fail(); set('prompt', args[++i]); }
    else { if (word.startsWith('-') || commands.has(word)) fail(); set('prompt', word); }
  }
  if (result.cwd?.length > 4096) fail();
  return result;
}

const claudeResumeLine = (id, interrupted) => id ? `claude --resume ${id}${interrupted ? ' "继续"' : ''}\r` : 'claude --continue\r';

function terminalAdapters(words) {
  const claude = words.claude, codex = words.codex;
  return {
    claude: {
      words: claude, roleTools: claudeRoleTools,
      terminal: {
        launch: claudeLaunch,
        resumeLine: claudeResumeLine,
        freshLine: 'claude\r',
        classify: (args, { native = false, remote = false } = {}) => {
          const options = beforeSeparator(args);
          if (!native && options.some(word => claudeWire.overrides.includes(word.split('=', 1)[0]))) return 'refused';
          if (claude.subcommands.includes(args[0]) || options.some(word => claude.versionHelp.includes(word))) return 'utility';
          return remote && options.some(word => claude.print.includes(word)) ? 'print' : 'conversation';
        },
        delegates: args => beforeSeparator(args).some(word => claude.print.includes(word)),
        converses: args => !args.some(word => claude.harmless.includes(word)) && (!args.length || /\s/.test(args[0]) || args[0].startsWith('-')),
        command: word => claude.utilities.includes(word) ? word : null,
        hookSession: true,
      },
      notes: {
        startup: note => ({ argv: note ? [claudeWire.flags.note, startupNote(note)] : [] }),
        message: (note, { native = false } = {}) => native ? { send: note } : { hook: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: note } } },
      },
    },
    codex: {
      words: codex, roleTools: codexRoleTools,
      terminal: {
        redirect: 'native', classify: (args, { alias } = {}) => codex.utilities.includes(alias || args[0]) ? 'passthrough' : 'native',
        launch: (args, routingOwned) => codexLaunch(args, codex, routingOwned),
        delegates: args => codex.print.includes(codexCommand(args)),
        converses: args => {
          const command = codexCommand(args);
          return !args.some(word => codex.harmless.includes(word)) && (command === undefined || nativeCommands.includes(command) || /\s/.test(command));
        },
      },
      notes: {
        startup: note => ({ config: { developer_instructions: note } }),
        message: (note, { native = false } = {}) => native ? { send: note } : {},
      },
    },
  };
}

function terminalLine(adapter, history) {
  const terminal = adapter?.terminal;
  if (!terminal || terminal.redirect) return null;
  if (history && terminal.resumeLine) return terminal.resumeLine(history.id);
  return terminal.freshLine ?? adapter.manifest.command + '\r';
}

module.exports = { claudeWire, claudeResumeLine, terminalAdapters, terminalLine };
