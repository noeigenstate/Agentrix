// The conductor's tools, served over MCP stdio to the lead session: the Claude SDK, Claude Code in a terminal and Codex
// all start it as `dispatch.cjs mcp`. A tool call runs Agentrix's worker engine in this process with its output collected,
// so the model never runs the engine itself. Each role takes its seat's model, effort and fast setting from the routing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { familyOf, launchSeat, liveSeatMap } = require(path.join(runtime, 'features/agents/call-seat.cjs'));
const REVIEWING = /^(reviewer|qa|security|a11y)(\/|$)/;
const PROTOCOL = '2025-06-18';

const text = description => ({ type: 'string', description });
const TOOLS = [
  { name: 'start_role', description: 'Start a role of the team on a task in the background and return its run id at once. The role uses its seat\'s model, effort and fast setting.',
    inputSchema: { type: 'object', required: ['seat', 'title', 'brief'], properties: {
      seat: text('Seat id from the team table, for example developer, developer/frontend or reviewer'),
      title: text('One line: what the role does'),
      brief: text('The task only, kept short: the goal, what was wrong, what must keep working, done-when. Agentrix adds the standing rules'),
      readOnly: { type: 'boolean', description: 'True for a role that only reads, such as a review or research' },
      allow: { type: 'array', items: { type: 'string' }, description: 'Globs of the files the role may change; required unless readOnly' },
      cwd: text('Folder to work in, such as a git worktree; the project folder by default'),
    } } },
  { name: 'roles_status', description: 'Show every role this conversation started: running or ended, for how long, and its last activity.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'role_result', description: 'Read the final answer of a role that has ended.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: text('The run id start_role returned') } } },
  { name: 'stop_role', description: 'Stop a running role.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: text('The run id start_role returned') } } },
];

function createRoleTools({ env = process.env, cwd = process.cwd(), engine }) {
  const runs = new Map();
  const call = async args => {
    let output = '';
    const code = await engine(args, { env, stdout: { write: chunk => { output += chunk; return true; } } });
    return { code, lines: output.split('\n') };
  };
  const conductor = () => {
    try { return fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode', 'utf8').trim() === 'conductor'; } catch { return false; }
  };
  const own = id => {
    const run = runs.get(id);
    if (!run) throw new Error(`No role run ${id} in this conversation.`);
    return run;
  };
  const describe = run => ({ id: run.id, seat: run.seat, title: run.title, state: run.end ? 'ended' : 'running',
    seconds: Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000), ...(run.end ? { end: run.end } : { activity: run.activity ?? null }) });

  async function refresh() {
    const open = [...runs.values()].filter(run => !run.end);
    if (!open.length) return;
    const { lines } = await call(['wait', ...open.map(run => run.id), '--cwd', open[0].cwd, '--timeout', '1']);
    for (const run of open) {
      const end = lines.find(line => line.startsWith(`[dispatch] ended ${run.id} `));
      if (end) Object.assign(run, { end, endedAt: Date.now() });
      else run.activity = lines.find(line => line.startsWith(`[dispatch] still running ${run.id} `)) ?? run.activity;
    }
  }

  const tools = {
    async start_role({ seat, title, brief, readOnly = false, allow = [], cwd: folder }) {
      if (!conductor()) throw new Error('Conductor mode is off: the team roles are unavailable.');
      const seats = liveSeatMap(env.AGENTRIX_BOOTSTRAP) ?? {}, id = launchSeat(seat, Object.keys(seats));
      if (!id || id === 'orchestrator') throw new Error(`Seat ${seat} is not an enabled role on this team.`);
      if (!readOnly && !allow.length) throw new Error('A role that changes files needs allow: the file globs it may change.');
      if (typeof brief !== 'string' || !brief.trim()) throw new Error('A role needs a non-empty brief.');
      if (typeof title !== 'string' || !title.trim()) throw new Error('A role needs a non-empty title.');
      const agent = familyOf(seats[id].model), work = folder || cwd;
      const files = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-role-'));
      const briefFile = path.join(files, 'brief.md'), out = path.join(files, 'answer.md');
      fs.writeFileSync(briefFile, brief, { mode: 0o600 });
      const role = readOnly ? REVIEWING.test(seat) ? 'review' : 'investigate' : 'exec';
      const { lines } = await call([agent, '--detach', '--seat', seat, '--role', role, '--title', title,
        ...(agent === 'claude' ? ['--permission', readOnly ? 'plan' : 'acceptEdits'] : readOnly ? ['--read-only'] : []),
        '--cwd', work, '--brief', briefFile, '--out', out, ...allow.flatMap(glob => ['--allow', glob])]);
      const started = lines.map(line => /^\[dispatch\] started (\S+) (.*)/.exec(line)).find(Boolean);
      if (!started) throw new Error(lines.find(line => line.startsWith('[dispatch] failed')) || 'The role did not start.');
      runs.set(started[1], { id: started[1], seat, title, out, cwd: work, startedAt: Date.now() });
      return { id: started[1], seat, started: started[2] };
    },
    async roles_status() { await refresh(); return [...runs.values()].map(describe); },
    async role_result({ id }) {
      const run = own(id);
      await refresh();
      return { ...describe(run), answer: run.end && fs.existsSync(run.out) ? fs.readFileSync(run.out, 'utf8') : null };
    },
    async stop_role({ id }) {
      const run = own(id);
      if (run.end) return describe(run);
      const { lines } = await call(['stop', id, '--cwd', run.cwd]);
      return { ...describe(run), stop: lines.filter(Boolean).pop() ?? null };
    },
  };
  return { tools, list: () => TOOLS };
}

// MCP over stdio: one JSON-RPC message per line.
async function serve({ roles, input = process.stdin, output = process.stdout }) {
  const reply = (id, result) => output.write(JSON.stringify({ jsonrpc: '2.0', id, ...result }) + '\n');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const { id, method, params } = message;
    if (id === undefined) continue;
    if (method === 'initialize') reply(id, { result: { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'agentrix', version: '1.0.0' } } });
    else if (method === 'ping') reply(id, { result: {} });
    else if (method === 'tools/list') reply(id, { result: { tools: roles.list() } });
    else if (method === 'tools/call') {
      const tool = roles.tools[params?.name];
      if (!tool) { reply(id, { error: { code: -32602, message: `Unknown tool ${params?.name}` } }); continue; }
      // Calls run one after another, so status and results never race a start.
      try { reply(id, { result: { content: [{ type: 'text', text: JSON.stringify(await tool(params.arguments || {}), null, 2) }] } }); }
      catch (error) { reply(id, { result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } }); }
    } else reply(id, { error: { code: -32601, message: `Unknown method ${method}` } });
  }
}

module.exports = { createRoleTools, serve, TOOLS };
