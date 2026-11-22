// The conductor's tools, served over MCP stdio to the lead session: the Claude SDK, Claude Code in a terminal and Codex
// all start it as `dispatch.cjs mcp`. A tool call runs Agentrix's worker engine in this process with its output collected,
// so the model never runs the engine itself. Each role takes its seat's model, effort and fast setting from the routing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateSmallScope, localWindowsCodex, roleReadiness, elevatedSetupMessage, answerDetachedRole } = require('./dispatch.cjs');
const { createRoleArtifacts, stampRoleArtifacts, sweepRoleArtifacts, RETENTION, ORPHAN_RETENTION } = require('./role-artifacts.cjs');

const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { familyOf, launchSeat, liveSeatMap, claudeLeadSeat } = require(path.join(runtime, 'features/agents/call-seat.cjs'));
const { validRefusals } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));
const REVIEWING = /^(reviewer|qa|security|a11y)(\/|$)/;
const PROTOCOL = '2025-06-18';
const RECENT_END_MS = 10 * 60 * 1000;
const READINESS_CACHE_MS = 5000;
const exec = promisify(execFile);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : undefined;

const text = description => ({ type: 'string', description });
const TOOLS = [
  { name: 'start_role', description: 'Start a background role with its seat settings. Returns a confirmed run id or instructions if the role cannot be dispatched.',
    inputSchema: { type: 'object', required: ['seat', 'title', 'brief'], properties: {
      seat: text('Seat id from the team table, for example developer, developer/frontend or reviewer'),
      title: text('One line: what the role does'),
      brief: text('The task only, kept short: the goal, what was wrong, what must keep working, done-when. Agentrix adds the standing rules'),
      readOnly: { type: 'boolean', description: 'True for a role that only reads, such as a review or research' },
      small: { type: 'boolean', description: 'Use a short brief for a precise read-only lookup or an edit to one or two named files.' },
      allow: { type: 'array', items: { type: 'string' }, description: 'Globs of the files the role may change; required unless readOnly' },
      cwd: text('Folder to work in, such as a git worktree; the project folder by default'),
      worktree: text('Branch suffix for a new work/<suffix> worktree from HEAD; for writable roles without cwd'),
    } } },
  { name: 'roles_status', description: 'Show running roles and endings first observed in the last 10 minutes, plus the number of earlier endings.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} } },
  { name: 'wait_roles', description: 'Wait until a selected role ends, loses its receipt, reports a new wait, or times out. Shows the selected roles.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'string' }, description: 'Run ids; defaults to all running roles in this conversation' },
      seconds: { type: 'integer', minimum: 0, maximum: 540, default: 240 },
    } } },
  { name: 'answer_role', description: 'Answer a hidden Claude role’s question or plan menu using the wait id and a listed option.',
    inputSchema: { type: 'object', required: ['id', 'wait', 'choice'], properties: {
      id: text('The run id start_role returned'),
      wait: text('The current menu id from wait_roles or roles_status'),
      choice: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string' }] },
    } } },
  { name: 'role_result', description: 'Read the final answer of a role that has ended.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', required: ['id'], properties: { id: text('The run id start_role returned') } } },
  { name: 'stop_role', description: 'Stop a running role.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: text('The run id start_role returned') } } },
];

function excludeDependencies(exclude) {
  let contents = '';
  try { contents = fs.readFileSync(exclude, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (contents.split(/\r?\n/).some(line => line === 'node_modules' || line === '/node_modules')) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, (contents && !contents.endsWith('\n') ? '\n' : '') + 'node_modules\n');
}

async function createWorktree(cwd, suffix) {
  if (typeof suffix !== 'string' || !suffix.trim()) throw new Error('worktree must be a non-empty branch suffix.');
  const branch = `work/${suffix}`;
  const ref = `refs/heads/${branch}`;
  const git = (args, folder = cwd) => exec('git', args, { cwd: folder, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
  let root;
  try { root = (await git(['rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch (error) {
    if (error.stderr?.includes('not a git repository')) throw new Error('The project is not a Git repository.');
    throw new Error('Could not determine the project Git root.');
  }
  const branchExists = () => git(['show-ref', '--verify', '--quiet', ref], root).then(() => true, error => {
    if (error.code === 1) return false;
    throw new Error('Could not check whether the worktree branch already exists.');
  });
  const duplicate = `Branch ${branch} already exists.`;
  if (await branchExists()) throw new Error(duplicate);

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentrix-role-worktree-'));
  // Reserve the ref separately so a failed checkout can only roll back its own branch.
  try { await git(['branch', '--', branch, 'HEAD'], root); }
  catch (error) {
    await fs.promises.rmdir(work).catch(() => {});
    const stderr = error.stderr ?? '';
    // Git can report the duplicate during its initial check or during the ref update.
    if (stderr.includes(`a branch named '${branch}' already exists`)
      || stderr.includes(`cannot lock ref '${ref}': reference already exists`)
      || (stderr.includes(`cannot lock ref '${ref}':`) && await branchExists())) {
      throw new Error(duplicate);
    }
    if (stderr.includes('is not a valid branch name')) throw new Error('The worktree suffix is not a valid Git branch name.');
    if (stderr.includes("not a valid object name: 'HEAD'")) throw new Error('Git could not resolve HEAD to create the worktree.');
    throw new Error('Git could not create a worktree from HEAD.');
  }
  const modules = path.join(root, 'node_modules');
  const link = path.join(work, 'node_modules');
  let linked = false;
  const rollback = async () => {
    if (linked) await fs.promises.unlink(link).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await git(['worktree', 'remove', '--force', work], root).catch(() => fs.promises.rmdir(work).catch(() => {}));
    await git(['branch', '-D', '--', branch], root);
  };
  try {
    await git(['worktree', 'add', '--quiet', work, branch], root).catch(cause => {
      throw new Error('Git could not create a worktree from HEAD.', { cause });
    });
    if ((await fs.promises.stat(modules).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isDirectory()) {
      const { stdout } = await git(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], work);
      excludeDependencies(stdout.trim());
      await fs.promises.symlink(modules, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    }
  } catch (error) {
    await rollback().catch(() => {});
    throw error;
  }
  return { cwd: work, branch, rollback };
}

function createRoleTools({ env = process.env, cwd = process.cwd(), engine, leadAgent, leadSeat,
  platform = process.platform, checkReadiness = roleReadiness, now = Date.now, tempRoot = os.tmpdir(), cleanup = false }) {
  const runs = new Map();
  let nextSweep = 0, sweeping = false;
  function sweep() {
    if (!cleanup || sweeping || now() < nextSweep) return;
    nextSweep = now() + 60_000;
    sweeping = true;
    void sweepRoleArtifacts(tempRoot, { now: now(), onRemoved: (folder, days) => {
      for (const run of runs.values()) if (run.artifacts.folder === folder) run.cleanupDays = days;
    } }).finally(() => { sweeping = false; });
  }
  sweep();
  let readiness;
  function sandboxStatus() {
    if (!readiness || readiness.until <= now()) {
      const entry = { until: Infinity };
      entry.result = Promise.resolve().then(() => checkReadiness(cwd, env)).catch(() => null)
        .then(status => {
          if (status !== 'ready') entry.until = now() + READINESS_CACHE_MS;
          return status;
        });
      readiness = entry;
    }
    return readiness.result;
  }
  async function sandboxRoute(agent, seat) {
    if (!['claude', 'codex'].includes(leadAgent) || !localWindowsCodex(agent, env, platform)) return {};
    const lead = leadAgent === 'claude' ? leadSeat ?? claudeLeadSeat(env.AGENTRIX_BOOTSTRAP) : null;
    if (leadAgent === 'claude' && (!lead || familyOf(lead.model) !== 'claude')) return {};
    const status = await sandboxStatus();
    if (status !== 'notConfigured' && status !== 'updateRequired') return {};
    if (leadAgent === 'codex') {
      const instruction = '这台电脑尚未完成 Codex 角色沙箱设置。请用 Codex 内置的子代理完成这个席位的工作。';
      return { instruction: instruction + ' ' + elevatedSetupMessage(env) };
    }
    return { roleFallback: { configured: seat.model, model: lead.model,
      effort: ['low', 'medium', 'high'].includes(seat.effort) ? seat.effort : lead.effort, fast: false } };
  }
  const call = async (args, options) => {
    let output = '';
    const timing = new Map();
    await engine(args, { ...options, env, stdout: { write: chunk => { output += chunk; return true; } }, onTiming: status => {
      timing.set(status.id, status);
      options?.onTiming?.(status);
    } });
    return { lines: output.split('\n'), timing };
  };
  const conductor = () => {
    try { return fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode', 'utf8').trim() === 'conductor'; } catch { return false; }
  };
  const own = id => {
    const run = runs.get(id);
    if (!run) throw new Error(`No role run ${id} in this conversation.`);
    return run;
  };
  const seenOwnerWaits = new Map();
  const describe = run => {
    const end = run.endedAt ?? run.observedEndAt;
    const measured = run.startedAt !== undefined && (!run.end || run.endedAt !== undefined);
    const elapsed = measured ? (end ?? Date.now()) - run.startedAt : (run.observedEndAt ?? Date.now()) - run.observedStartAt;
    return { id: run.id, seat: run.seat, title: run.title, state: run.end ? 'ended' : 'running',
      seconds: Math.max(0, Math.round(elapsed / 1000)),
      startSeconds: Math.max(0, ((run.confirmedAt ?? run.observedStartAt) - run.calledAt) / 1000),
      endedAt: end === undefined ? null : new Date(end).toISOString(),
      refused: run.refused ?? [],
      ...(run.routing && { routing: run.routing }),
      ...(run.needsDecision && { needsDecision: true }),
      ...(run.end ? { end: run.end } : { activity: run.activity ?? null, ...(run.ownerWait && { waiting: run.ownerWait }), ...(run.menu && { menu: run.menu }) }) };
  };

  async function refreshGroup(folder, open, seconds, untilAny, signal) {
    const args = ['wait', ...open.map(run => run.id), '--cwd', folder, '--timeout', String(seconds)];
    const { lines, timing } = await call(args, { untilAny, seenOwnerWaits, signal });
    let ownerTransition = false;
    const failure = lines.find(line => line.startsWith('[dispatch] failed:'))?.slice('[dispatch] failed:'.length).trim();
    for (const run of open) {
      if (run.end) continue;
      const status = timing.get(run.id);
      run.startedAt ??= timestamp(status?.startedAt);
      run.confirmedAt ??= timestamp(status?.confirmedAt);
      if (status?.routing) run.routing = status.routing;
      if (validRefusals(status?.refused) && status.refused.length >= (run.refused?.length ?? 0)) run.refused = status.refused;
      if (status?.ownerWaitSequence >= (run.ownerWaitSequence ?? 0)) {
        if (status.ownerWaitSequence > (run.ownerWaitSequence ?? 0) || !status.ownerWait) {
          Object.assign(run, { ownerWait: status.ownerWait, ownerWaitSequence: status.ownerWaitSequence, menu: status.menu });
        }
        if (untilAny && status.ownerWaitSequence > (seenOwnerWaits.get(run.id) ?? 0)) {
          ownerTransition = true;
          seenOwnerWaits.set(run.id, status.ownerWaitSequence);
        }
      }
      const end = lines.find(line => line.startsWith(`[dispatch] ended ${run.id} `));
      const loss = lines.includes(`[dispatch] unknown run ${run.id}`) ? `unknown run ${run.id}` : failure;
      if (end) {
        Object.assign(run, { end, endedAt: timestamp(status?.endedAt), observedEndAt: Date.now(), needsDecision: status?.needsDecision === true });
        sweep();
      }
      else if (loss) Object.assign(run, { end: `lost: ${loss}`, observedEndAt: Date.now(), lost: true });
      else {
        const activity = lines.find(line => line.startsWith(`[dispatch] still running ${run.id} `));
        if (activity) run.activity = activity;
      }
    }
    return ownerTransition;
  }

  async function refresh(selected, seconds = 0, untilAny = false, cancellation) {
    const groups = new Map();
    for (const run of selected) {
      if (run.end) continue;
      if (!groups.has(run.cwd)) groups.set(run.cwd, []);
      groups.get(run.cwd).push(run);
    }
    const controller = untilAny && groups.size > 1 ? new AbortController() : undefined;
    const signal = cancellation && controller ? AbortSignal.any([cancellation, controller.signal]) : cancellation ?? controller?.signal;
    try {
      await Promise.all([...groups].map(async ([folder, open]) => {
        const ownerTransition = await refreshGroup(folder, open, seconds, untilAny, signal);
        if (ownerTransition || open.some(run => run.end)) controller?.abort();
      }));
    } finally { controller?.abort(); }
  }

  const tools = {
    async start_role({ seat, title, brief, readOnly = false, allow = [], cwd: folder, worktree, small = false }) {
      const calledAt = Date.now();
      if (!conductor()) throw new Error('Conductor mode is off: the team roles are unavailable.');
      const seats = liveSeatMap(env.AGENTRIX_BOOTSTRAP) ?? {}, id = launchSeat(seat, Object.keys(seats));
      if (!id || id === 'orchestrator') throw new Error(`Seat ${seat} is not an enabled role on this team.`);
      if (worktree !== undefined && readOnly) throw new Error('A read-only role cannot create a worktree.');
      if (worktree !== undefined && folder !== undefined) throw new Error('Specify either cwd or worktree.');
      if (typeof small !== 'boolean') throw new Error('small must be a boolean.');
      if (small) validateSmallScope(readOnly, allow);
      if (!readOnly && !allow.length) throw new Error('A role that changes files needs allow: the file globs it may change.');
      if (typeof brief !== 'string' || !brief.trim()) throw new Error('A role needs a non-empty brief.');
      if (typeof title !== 'string' || !title.trim()) throw new Error('A role needs a non-empty title.');
      const configuredAgent = familyOf(seats[id].model);
      const { instruction, roleFallback } = await sandboxRoute(configuredAgent, seats[id]);
      if (instruction) return { instruction };
      const agent = roleFallback ? 'claude' : configuredAgent;
      const checkout = worktree === undefined ? undefined : await createWorktree(cwd, worktree);
      let waitingId;
      try {
        const work = checkout?.cwd ?? (folder || cwd);
        const binding = { agent, allow, readOnly, cwd: work };
        const artifacts = await createRoleArtifacts(tempRoot);
        const briefFile = path.join(artifacts.folder, 'brief.md'), out = path.join(artifacts.folder, 'answer.md');
        fs.writeFileSync(briefFile, brief, { mode: 0o600 });
        const role = readOnly ? REVIEWING.test(seat) ? 'review' : 'investigate' : 'exec';
        const { lines, timing } = await call([agent, '--detach', '--seat', seat, '--role', role, '--title', title,
          ...(small ? ['--small'] : []),
          ...(agent === 'claude' ? ['--permission', readOnly ? 'dontAsk' : 'acceptEdits'] : readOnly ? ['--read-only'] : []),
          '--cwd', work, '--brief', briefFile, '--out', out, ...allow.flatMap(glob => ['--allow', glob])], {
          roleArtifacts: artifacts, ...(roleFallback && { roleFallback }),
          onTiming: status => {
            if (waitingId || !(status.waitingLine || status.ownerWait)) return;
            waitingId = status.id;
            runs.set(waitingId, { id: waitingId, seat, title, out, artifacts, ...binding, calledAt, observedStartAt: Date.now(),
              activity: status.waitingLine ?? status.ownerWait, ownerWait: status.ownerWait });
          },
        });
        const started = lines.map(line => /^\[dispatch\] started (\S+) (.*)/.exec(line)).find(Boolean);
        if (!started) throw new Error(lines.find(line => line.startsWith('[dispatch] failed')) || 'The role did not start.');
        const status = timing.get(started[1]);
        const run = runs.get(started[1]) || { id: started[1], seat, title, out, artifacts, ...binding, calledAt, observedStartAt: Date.now() };
        if (status?.routing) run.routing = status.routing;
        Object.assign(run, { startedAt: timestamp(status?.startedAt), confirmedAt: timestamp(status?.confirmedAt), activity: status?.ownerWait ?? null, ownerWait: status?.ownerWait });
        runs.set(started[1], run);
        return { id: started[1], seat, started: started[2], ...(checkout && { cwd: work, branch: checkout.branch }) };
      } catch (error) {
        if (waitingId) runs.delete(waitingId);
        await checkout?.rollback().catch(() => {});
        throw error;
      }
    },
    async roles_status() {
      await refresh([...runs.values()]);
      const cutoff = Date.now() - RECENT_END_MS;
      const roles = [...runs.values()].filter(run => !run.end || run.observedEndAt >= cutoff).map(describe);
      return { roles, earlierEnded: runs.size - roles.length };
    },
    async wait_roles({ ids, seconds = 240 } = {}, signal) {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 540) throw new Error('seconds must be an integer between 0 and 540.');
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('ids must be an array of run ids.');
      const selected = ids === undefined ? [...runs.values()].filter(run => !run.end) : [...new Set(ids)].map(own);
      await refresh(selected, selected.some(run => run.end) ? 0 : seconds, true, signal);
      return selected.map(describe);
    },
    async answer_role({ id, wait, choice }) {
      const run = own(id);
      if (typeof wait !== 'string' || !/^[a-f\d-]{36}$/.test(wait)) throw new Error('A current menu wait id is required.');
      if (!(Number.isInteger(choice) && choice > 0) && !(typeof choice === 'string' && choice.length > 0 && choice.length <= 512)) {
        throw new Error('Choose a listed option number or exact label.');
      }
      await refresh([run]);
      if (run.end || !run.menu) throw new Error('The role is not waiting on a menu.');
      if (run.menu.id !== wait) throw new Error('That menu wait is stale.');
      if (run.menu.kind === 'permission') throw new Error('Permission prompts cannot be answered by the lead.');
      const result = await answerDetachedRole(run, { wait, choice }, env);
      if (result?.status !== 'delivered') throw new Error(`The answer was not delivered (${result?.reason ?? 'unknown'}).`);
      return { id, wait, status: result.status };
    },
    async role_result({ id }) {
      const run = own(id);
      await refresh([run], 1);
      const answer = run.end && !run.lost ? await fs.promises.readFile(run.out, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      }) : null;
      if (answer !== null) {
        run.answerRead = true;
        await stampRoleArtifacts(run.artifacts, 'read');
      } else if (run.end) {
        const elapsed = now() - (run.endedAt ?? run.observedEndAt);
        const missing = !fs.existsSync(run.artifacts.folder);
        const days = run.cleanupDays !== undefined ? run.cleanupDays : elapsed >= ORPHAN_RETENTION ? 30 : elapsed >= RETENTION ? 7 : null;
        if (run.cleanupDays !== undefined || missing && (days || run.answerRead)) {
          const notice = days ? `Answer removed by cleanup after ${days} days.` : 'Answer removed by cleanup to make room for newer role folders.';
          return { ...describe(run), answer: notice, answerRemoved: true };
        }
      }
      return { ...describe(run), answer };
    },
    async stop_role({ id }) {
      const run = own(id);
      if (run.end) return describe(run);
      const { lines } = await call(['stop', id, '--cwd', run.cwd]);
      await refresh([run]);
      return { ...describe(run), stop: lines.filter(Boolean).pop() ?? null };
    },
  };
  return { tools, list: () => TOOLS };
}

// MCP over stdio: one JSON-RPC message per line.
async function serve({ roles, input = process.stdin, output = process.stdout }) {
  const reply = (id, result) => {
    try { output.write(JSON.stringify({ jsonrpc: '2.0', id, ...result }) + '\n'); } catch {}
  };
  const controller = new AbortController();
  const pending = new Set();
  const callTool = async (id, params) => {
    try {
      const result = await roles.tools[params.name](params.arguments || {}, controller.signal);
      reply(id, { result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    }
    catch (error) { reply(id, { result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } }); }
  };
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const { id, method, params } = message;
      if (id === undefined) continue;
      if (method === 'initialize') {
        reply(id, { result: { protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} },
          serverInfo: { name: 'agentrix', version: '1.0.0' } } });
      } else if (method === 'ping') reply(id, { result: {} });
      else if (method === 'tools/list') reply(id, { result: { tools: roles.list() } });
      else if (method === 'tools/call') {
        if (!Object.hasOwn(roles.tools, params?.name)) { reply(id, { error: { code: -32602, message: `Unknown tool ${params?.name}` } }); continue; }
        const request = callTool(id, params).finally(() => pending.delete(request));
        pending.add(request);
      } else reply(id, { error: { code: -32601, message: `Unknown method ${method}` } });
    }
  } finally {
    controller.abort();
    await Promise.all(pending);
  }
}

module.exports = { createRoleTools, serve, TOOLS };
