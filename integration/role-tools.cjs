// The conductor's tools, served over MCP stdio to the lead session: the Claude SDK, Claude Code in a terminal and Codex
// all start it as `dispatch.cjs mcp`. A tool call runs Agentrix's worker engine in this process with its output collected,
// so the model never runs the engine itself. Each role takes its seat's model, effort and fast setting from the routing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { validateSmallScope, answerDetachedRole,
  renderDispatchLine, renderDispatchStart } = require('./dispatch.cjs');
const { createRoleArtifacts, stampRoleArtifacts, sweepRoleArtifacts, readRoleResultFile, roleResultFields,
  RETENTION, ORPHAN_RETENTION } = require('./role-artifacts.cjs');

const runtime = path.join(__dirname, fs.existsSync(path.join(__dirname, 'electron')) ? 'electron' : '../electron');
const { launchSeat, liveSeatMap } = require(path.join(runtime, 'features/agents/call-seat.cjs'));
const { workerOf, agentOfModel } = require(path.join(runtime, 'features/cli-adapters/workers.cjs'));
const { readSessionMode, validRefusals } = require(path.join(runtime, 'features/agents/dispatch-events.cjs'));
const REVIEWING = /^(reviewer|qa|security|a11y)(\/|$)/;
const PROTOCOL = '2025-06-18';
const RECENT_END_MS = 10 * 60 * 1000;
const RECENT_END_LIMIT = 10;
const SUMMARY_TITLE_LIMIT = 64;
const exec = promisify(execFile);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : undefined;

const text = description => ({ type: 'string', description });
const TOOLS = [
  { name: 'start_role',
    description: 'Start a role with its seat settings. Returns a run id and any worktree base and source. '
      + 'Claude roles can run commands and decide whether to run tests and which task-related tests to run. '
      + 'They must never commit, push, or run git reset --hard. Read-only roles must leave project files untouched.',
    inputSchema: { type: 'object', required: ['seat', 'title', 'brief'], properties: {
      seat: text('Seat id from the team table, for example developer, developer/frontend or reviewer'),
      title: text('One line: what the role does'),
      brief: text('The task only, kept short: the goal, what was wrong, what must keep working, done-when. Agentrix adds the standing rules'),
      readOnly: { type: 'boolean', description: 'Leave project files untouched. Claude roles can run commands and tests.' },
      small: { type: 'boolean', description: 'Use a short brief for a precise read-only lookup or an edit to one or two named files.' },
      allow: { type: 'array', items: { type: 'string' }, description: 'Globs of the files the role may change; required unless readOnly' },
      cwd: text('Folder to work in. With worktree, a same-repository cwd supplies HEAD when from is omitted or HEAD.'),
      worktree: text('New work/<suffix> worktree for a writable role. Without from or cwd, uses the last role’s valid same-repository HEAD, then the project HEAD.'),
      from: text('Base branch or commit in this repository. HEAD uses a supplied same-repository cwd or the project checkout. Requires worktree.'),
    } } },
  { name: 'roles_status',
    description: 'Show full running roles and the 10 newest endings first observed in the last 10 minutes, with counts for older and omitted recent endings. Use role_result for details.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} } },
  { name: 'wait_roles',
    description: 'Wait for an ending, lost receipt, active owner wait, or timeout. Returns full details for roles that changed and one-line summaries for the rest.',
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
  { name: 'role_result', description: 'Read a role’s full status, refusal details, and final answer when available.',
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

async function copyWorktreeDependencies(modules, destination) {
  if (await fs.promises.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; })) return;
  const source = await fs.promises.realpath(modules);
  const links = [];
  await fs.promises.cp(source, destination, {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE,
    async filter(from, to) {
      if (!(await fs.promises.lstat(from)).isSymbolicLink()) return true;
      const target = await fs.promises.realpath(from).catch(error => {
        if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
      });
      if (target) {
        const relative = path.relative(source, target);
        if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
          links.push([to, path.join(destination, relative), (await fs.promises.stat(target)).isDirectory()]);
        }
      }
      return false;
    },
  });
  // Relative links remain inside this copy. Windows directory links use a private junction.
  for (const [file, target, directory] of links) {
    if (process.platform === 'win32' && directory) await fs.promises.symlink(target, file, 'junction');
    else if (process.platform === 'win32') await fs.promises.copyFile(target, file, fs.constants.COPYFILE_FICLONE);
    else await fs.promises.symlink(path.relative(path.dirname(file), target) || '.', file);
  }
}

async function worktreeBaseFolder(git, root, folder) {
  if (!folder) return;
  const commonArgs = ['--git-common-dir'];
  const source = await git(['rev-parse', '--is-inside-work-tree', ...commonArgs], folder).catch(() => null);
  const [inside, sourceCommon] = source?.stdout.trim().split(/\r?\n/) ?? [];
  if (inside !== 'true' || !sourceCommon) return;
  const { stdout } = await git(['rev-parse', ...commonArgs], root);
  const [projectGit, sourceGit] = await Promise.all([path.resolve(root, stdout.trim()), path.resolve(folder, sourceCommon)].map(dir => fs.promises.realpath(dir)));
  if (path.relative(projectGit, sourceGit) === '') return folder;
}

async function resolveWorktreeCommit(git, from, folder) {
  const revision = from ?? 'HEAD';
  const invalid = () => new Error(from === undefined ? 'Git could not resolve HEAD to create the worktree.' : 'from must resolve to a Git commit in this project.');
  // One positional argv word, with no option or revision-set syntax.
  if (revision.startsWith('-') || revision.includes('\0')) throw invalid();
  await git(['check-ref-format', '--allow-onelevel', revision], folder).catch(() => { throw invalid(); });
  return git(['rev-parse', '--verify', `${revision}^{commit}`], folder).catch(() => { throw invalid(); });
}

async function createWorktree(cwd, suffix, folder, from, lastRoleCwd) {
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
  const useLastRole = from === undefined && folder === undefined;
  const baseFolder = from === undefined || from === 'HEAD'
    ? await worktreeBaseFolder(git, root, useLastRole ? lastRoleCwd : folder) : undefined;
  const baseSource = { kind: baseFolder ? (useLastRole ? 'last-role' : 'cwd') : 'project', cwd: baseFolder ?? root, ref: from ?? 'HEAD' };
  const { stdout: commitOutput } = await resolveWorktreeCommit(git, from, baseSource.cwd);
  const commit = commitOutput.trim();
  const { stdout: shortCommit } = await git(['rev-parse', '--short', commit], root);
  const branchExists = () => git(['show-ref', '--verify', '--quiet', ref], root).then(() => true, error => {
    if (error.code === 1) return false;
    throw new Error('Could not check whether the worktree branch already exists.');
  });
  const duplicate = `Branch ${branch} already exists.`;
  if (await branchExists()) throw new Error(duplicate);

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentrix-role-worktree-'));
  // Reserve the ref separately so a failed checkout can only roll back its own branch.
  try { await git(['branch', '--', branch, commit], root); }
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
    throw new Error('Git could not create the worktree branch.');
  }
  const modules = path.join(root, 'node_modules');
  const rollback = async () => {
    await git(['worktree', 'remove', '--force', work], root).catch(() => fs.promises.rmdir(work).catch(() => {}));
    await git(['branch', '-D', '--', branch], root);
  };
  try {
    await git(['worktree', 'add', '--quiet', work, branch], root).catch(cause => {
      throw new Error('Git could not check out the worktree branch.', { cause });
    });
    if ((await fs.promises.stat(modules).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isDirectory()) {
      const { stdout } = await git(['rev-parse', '--git-path', 'info/exclude'], work);
      excludeDependencies(path.resolve(work, stdout.trim()));
      await copyWorktreeDependencies(modules, path.join(work, 'node_modules'));
    }
  } catch (error) {
    await rollback().catch(() => {});
    throw error;
  }
  return { cwd: work, branch, base: shortCommit.trim(), baseSource, rollback };
}

function elapsedSeconds(run) {
  const end = run.endedAt ?? run.observedEndAt;
  const measured = run.startedAt !== undefined && (!run.end || run.endedAt !== undefined);
  const elapsed = measured ? (end ?? Date.now()) - run.startedAt : (run.observedEndAt ?? Date.now()) - run.observedStartAt;
  return Math.max(0, Math.round(elapsed / 1000));
}

function summarize(run) {
  const title = Array.from(run.title);
  return { id: run.id, seat: run.seat, title: title.length <= SUMMARY_TITLE_LIMIT ? run.title : title.slice(0, SUMMARY_TITLE_LIMIT - 1).join('') + '…',
    state: run.end ? 'ended' : 'running', seconds: elapsedSeconds(run), ...(run.end && { reason: run.reason }),
    ...(run.legacy && { legacy: true }),
    ...(!run.end && run.ownerWait && { waiting: run.ownerWait }),
    ...(!run.end && run.ownerWait && run.menu && { menu: { id: run.menu.id, kind: run.menu.kind } }),
    ...(run.needsDecision && { needsDecision: true }), refusedCount: run.refusedCount ?? run.refused?.length ?? 0 };
}

function createRoleTools({ env = process.env, cwd = process.cwd(), engine,
  now = Date.now, tempRoot = os.tmpdir(), cleanup = false }) {
  const runs = new Map();
  const ssh = env.AGENTRIX_REMOTE_ROLE_TOOLS === '1';
  let lastRoleCwd;
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
  const call = async (args, options) => {
    const events = [];
    const timing = new Map();
    await engine(args, { ...options, env, onEvent: event => events.push(event), onTiming: status => {
      timing.set(status.id, status);
      options?.onTiming?.(status);
    } });
    return { events, timing };
  };
  const conductor = () => {
    if (!env.AGENTRIX_BOOTSTRAP) return false;
    try { return readSessionMode(fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode.env', 'utf8')) === 'conductor'; }
    catch (error) {
      if (error.code !== 'ENOENT') return false;
      try { return fs.readFileSync(env.AGENTRIX_BOOTSTRAP + '.mode', 'utf8').trim() === 'conductor'; } catch { return false; }
    }
  };
  const own = id => {
    const run = runs.get(id);
    if (!run) throw new Error(`No role run ${id} in this conversation.`);
    return run;
  };
  const seenOwnerWaits = new Map();
  const describe = run => {
    const end = run.endedAt ?? run.observedEndAt;
    return { id: run.id, seat: run.seat, title: run.title, state: run.end ? 'ended' : 'running',
      seconds: elapsedSeconds(run),
      startSeconds: Math.max(0, ((run.confirmedAt ?? run.observedStartAt) - run.calledAt) / 1000),
      endedAt: end === undefined ? null : new Date(end).toISOString(),
      refused: run.refused ?? [],
      ...(run.routing && { routing: run.routing }),
      ...(run.needsDecision && { needsDecision: true }),
      ...(run.legacy && { legacy: true, reason: run.reason }),
      ...(run.end ? { end: run.end } : { activity: run.activity ?? null, ...(run.ownerWait && { waiting: run.ownerWait }), ...(run.menu && { menu: run.menu }) }) };
  };

  async function refreshGroup(folder, open, seconds, untilAny, signal) {
    const args = ['wait', ...open.map(run => run.id), '--cwd', folder, '--timeout', String(seconds)];
    const { events, timing } = await call(args, { untilAny, signal });
    for (const run of open) {
      if (run.end) continue;
      const status = timing.get(run.id);
      run.startedAt ??= timestamp(status?.startedAt);
      run.confirmedAt ??= timestamp(status?.confirmedAt);
      if (status?.routing) run.routing = status.routing;
      if (validRefusals(status?.refused) && status.refused.length >= (run.refused?.length ?? 0)) run.refused = status.refused;
      if (status?.ownerWaitSequence >= (run.ownerWaitSequence ?? 0)) {
        Object.assign(run, { ownerWait: status.ownerWait, ownerWaitSequence: status.ownerWaitSequence, menu: status.menu });
        if (untilAny && status.ownerWait && status.ownerWaitSequence > (seenOwnerWaits.get(run.id) ?? 0)) {
          seenOwnerWaits.set(run.id, status.ownerWaitSequence);
        }
      }
      const relevant = events.filter(event => event.id === run.id);
      const end = relevant.find(event => event.type === 'dispatch.ended');
      if (end) {
        const legacy = end.result.source === 'legacy';
        Object.assign(run, { end: renderDispatchLine(end), endedAt: timestamp(status?.endedAt), observedEndAt: Date.now(),
          reason: end.reason, legacy, refusedCount: legacy ? null : end.refused.count,
          needsDecision: end.needsDecision === true || legacy && status?.needsDecision === true });
        sweep();
      }
      else if (relevant.some(event => event.type === 'dispatch.unknown-run')) {
        Object.assign(run, { end: `lost: unknown run ${run.id}`, observedEndAt: Date.now(), lost: true, reason: 'lost' });
      }
      else {
        const activity = relevant.find(event => event.type === 'dispatch.running');
        if (activity) run.activity = renderDispatchLine(activity);
      }
    }
    return open.some(run => run.end || run.ownerWait);
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
        if (await refreshGroup(folder, open, seconds, untilAny, signal)) controller?.abort();
      }));
    } finally { controller?.abort(); }
  }

  const tools = {
    async start_role({ seat, title, brief, readOnly = false, allow = [], cwd: folder, worktree, from, small = false }) {
      const calledAt = Date.now();
      if (!conductor()) throw new Error('Conductor mode is off: the team roles are unavailable.');
      const seats = liveSeatMap(env.AGENTRIX_BOOTSTRAP) ?? {}, id = launchSeat(seat, Object.keys(seats));
      if (!id || id === 'orchestrator') throw new Error(`Seat ${seat} is not an enabled role on this team.`);
      if (worktree !== undefined && readOnly) throw new Error('A read-only role cannot create a worktree.');
      if (from !== undefined && (worktree === undefined || typeof from !== 'string' || !from.trim())) {
        throw new Error('from must be a non-empty branch or commit and requires worktree.');
      }
      if (typeof small !== 'boolean') throw new Error('small must be a boolean.');
      if (small) validateSmallScope(readOnly, allow);
      if (!readOnly && !allow.length) throw new Error('A role that changes files needs allow: the file globs it may change.');
      if (typeof brief !== 'string' || !brief.trim()) throw new Error('A role needs a non-empty brief.');
      if (typeof title !== 'string' || !title.trim()) throw new Error('A role needs a non-empty title.');
      const agent = agentOfModel(seats[id].model);
      const checkout = worktree === undefined ? undefined : await createWorktree(cwd, worktree, folder, from, lastRoleCwd);
      let waitingId;
      try {
        const work = checkout?.cwd ?? (folder || cwd);
        const binding = { agent, allow, readOnly, cwd: work };
        const artifacts = await createRoleArtifacts(tempRoot);
        const briefFile = path.join(artifacts.folder, 'brief.md'), out = path.join(artifacts.folder, 'answer.md');
        fs.writeFileSync(briefFile, brief, { mode: 0o600 });
        const role = readOnly ? REVIEWING.test(seat) ? 'review' : 'investigate' : 'exec';
        const { events, timing } = await call([agent, '--detach', '--seat', seat, '--role', role, '--title', title,
          ...(small ? ['--small'] : []),
          ...workerOf(agent).roleArgs(readOnly),
          '--cwd', work, '--brief', briefFile, '--out', out, ...allow.flatMap(glob => ['--allow', glob])], {
          roleArtifacts: artifacts,
          onTiming: status => {
            if (waitingId || !(status.waiting || status.ownerWait)) return;
            waitingId = status.id;
            runs.set(waitingId, { id: waitingId, seat, title, out, artifacts, ...binding, calledAt, observedStartAt: Date.now(),
              activity: status.waiting ? renderDispatchLine(status.waiting) : status.ownerWait, ownerWait: status.ownerWait });
          },
        });
        const started = events.find(event => event.type === 'dispatch.started');
        const pending = events.find(event => event.type === 'dispatch.detached');
        if (!started && !pending) {
          const failure = events.find(event => event.type === 'dispatch.failed' || event.type === 'dispatch.start-failed');
          throw new Error(failure ? renderDispatchLine(failure) : 'The role did not start.');
        }
        const runId = (started ?? pending).id, status = timing.get(runId);
        const run = runs.get(runId) || { id: runId, seat, title, out, artifacts, ...binding, calledAt, observedStartAt: Date.now() };
        if (status?.routing) run.routing = status.routing;
        Object.assign(run, { startedAt: timestamp(status?.startedAt), confirmedAt: timestamp(status?.confirmedAt), activity: status?.ownerWait ?? null, ownerWait: status?.ownerWait });
        runs.set(runId, run);
        lastRoleCwd = work;
        return { id: runId, seat, ...(started ? { started: renderDispatchStart(started) } : { state: 'starting' }),
          ...(checkout && { cwd: work, branch: checkout.branch, base: checkout.base, baseSource: checkout.baseSource }) };
      } catch (error) {
        if (waitingId) runs.delete(waitingId);
        await checkout?.rollback().catch(() => {});
        throw error;
      }
    },
    async roles_status() {
      await refresh([...runs.values()]);
      const cutoff = Date.now() - RECENT_END_MS;
      const running = [...runs.values()].filter(run => !run.end);
      const recent = [...runs.values()].reverse().filter(run => run.end && run.observedEndAt >= cutoff)
        .sort((a, b) => (b.endedAt ?? b.observedEndAt) - (a.endedAt ?? a.observedEndAt) || b.observedEndAt - a.observedEndAt);
      return { roles: [...running.map(describe), ...recent.slice(0, RECENT_END_LIMIT).map(summarize)],
        earlierEnded: runs.size - running.length - recent.length, omittedRecentEnded: Math.max(0, recent.length - RECENT_END_LIMIT) };
    },
    async wait_roles({ ids, seconds = 240 } = {}, signal) {
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 540) throw new Error('seconds must be an integer between 0 and 540.');
      if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('ids must be an array of run ids.');
      const selected = ids === undefined ? [...runs.values()].filter(run => !run.end) : [...new Set(ids)].map(own);
      const waitState = run => [run.end, run.ownerWait, run.ownerWaitSequence, seenOwnerWaits.get(run.id)];
      const before = selected.map(waitState);
      await refresh(selected, selected.some(run => run.end) ? 0 : seconds, true, signal);
      return selected.map((run, index) => waitState(run).some((value, field) => value !== before[index][field]) ? describe(run) : summarize(run));
    },
    async answer_role({ id, wait, choice }) {
      if (ssh) throw new Error('SSH roles have no interactive menu to answer.');
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
      const result = run.end && !run.lost ? await readRoleResultFile(run.artifacts.folder, id) : null;
      if (result) {
        run.answerRead = true;
        await stampRoleArtifacts(run.artifacts, 'read');
        return { ...describe(run), ...roleResultFields(result) };
      }
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
      const { events } = await call(['stop', id, '--cwd', run.cwd]);
      await refresh([run]);
      const stop = events.at(-1);
      return { ...describe(run), stop: stop ? renderDispatchLine(stop, { compactFailure: true }) : null };
    },
  };
  const available = () => !ssh || conductor();
  return { tools, available, list: () => available() ? TOOLS : [] };
}

function formatRoleRows(roles, indent) {
  const padding = ' '.repeat(indent);
  const rows = roles.map(role => padding + JSON.stringify(role, null, 'startSeconds' in role ? 2 : 0).replaceAll('\n', '\n' + padding));
  return rows.length ? `[\n${rows.join(',\n')}\n${padding.slice(2)}]` : '[]';
}

function toolResultText(name, result) {
  if (name === 'wait_roles') return formatRoleRows(result, 2);
  if (name === 'roles_status') {
    const { roles, ...counts } = result;
    const fields = [`"roles": ${formatRoleRows(roles, 4)}`, ...Object.entries(counts).map(([key, value]) => `${JSON.stringify(key)}: ${value}`)];
    return `{\n  ${fields.join(',\n  ')}\n}`;
  }
  return JSON.stringify(result, null, 2);
}

// MCP over stdio: one JSON-RPC message per line.
async function serve({ roles, name = 'agentrix', input = process.stdin, output = process.stdout }) {
  const reply = (id, result) => {
    try { output.write(JSON.stringify({ jsonrpc: '2.0', id, ...result }) + '\n'); } catch {}
  };
  const controller = new AbortController();
  const pending = new Set();
  const callTool = async (id, params) => {
    try {
      if (roles.available?.() === false) throw new Error('Conductor mode is off: the team roles are unavailable.');
      const result = await roles.tools[params.name](params.arguments || {}, controller.signal);
      reply(id, { result: { content: [{ type: 'text', text: toolResultText(params.name, result) }] } });
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
          serverInfo: { name, version: '1.0.0' } } });
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
