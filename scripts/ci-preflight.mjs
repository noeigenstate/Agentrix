import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withGuiLock } from './gui-lock.mjs';
import {
  workflowFile, parseWorkflow, localPlan, selectSteps, portablePlan, renderRun, stepEnvironment,
  assertPackagingAllowed, pythonCommand, parseOrigin, preflightBranch, pushArguments,
  expectedRemoteJobs, verifyDispatchedRun, pollWorkflowRun, assessRemoteJobs, tailLines, collectLogExcerpt, parseArguments,
} from './ci-preflight-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage:
  node scripts/ci-preflight.mjs local [--from <step> | --only <step>]
  node scripts/ci-preflight.mjs remote [--ref ci/preflight-<name>]

Step selectors accept a workflow step number, name, key, or unique name fragment.
Example: node scripts/ci-preflight.mjs local --only "npm test"
Local mode reuses installed dependencies and CLIs. Full local runs include GUI tests.
TEMP uses COM ShortPath on a new long-named folder. If 8.3 aliases are disabled,
a verified short-leaf fallback is used with a warning that runner-alias fidelity is reduced.
Remote mode defaults to ci/preflight-<12-character HEAD SHA> and dispatches GitHub Actions.
--ref selects only a new ci/preflight-* destination (lowercase letters, numbers, hyphens).
The source is always committed HEAD. Existing branches are never overwritten; cleanup uses an exact-SHA lease.`;

function gitResult(args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...options });
}

function git(args) {
  const result = gitResult(args);
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed (exit ${result.status ?? 'unavailable'}).`);
  return result.stdout.trim();
}

function powershell() {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  for (const command of ['pwsh', 'powershell.exe']) {
    const result = spawnSync(command, [...args, '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0 || !/^\d+$/.test(result.stdout.trim())) continue;
    if (command === 'pwsh' && Number(result.stdout.trim()) < 7) continue;
    if (command !== 'pwsh') console.warn('WARNING: PowerShell 7 (pwsh) is unavailable. Using Windows PowerShell with reduced CI shell fidelity.');
    return { command, args };
  }
  throw new Error('Local Windows preflight requires PowerShell 7 or Windows PowerShell.');
}

async function shortTemporaryDirectory(shell) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentrix-ci-preflight-long-temp-'));
  const script = `
$ErrorActionPreference = 'Stop'
$files = New-Object -ComObject Scripting.FileSystemObject
[Console]::Write($files.GetFolder($env:AGENTRIX_PREFLIGHT_TEMP).ShortPath)
`;
  const shortPath = folder => {
    const result = spawnSync(shell.command, [...shell.args, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENTRIX_PREFLIGHT_TEMP: folder },
    });
    return result.status === 0 ? result.stdout.trim() : '';
  };
  const usable = folder => /^[A-Za-z]:\\/.test(folder) && folder.slice(3).split('\\').every(part => /^[^ .\\/]{1,8}(?:\.[^ .\\/]{1,3})?$/.test(part));
  const shortened = shortPath(directory);
  if (usable(shortened) && path.basename(shortened).includes('~')) return shortened;
  console.warn('WARNING: the new long TEMP folder has no usable COM ShortPath alias (8.3 names may be disabled). Runner-alias behavior cannot be reproduced; using a verified short-leaf fallback.');
  const fallback = await fsp.mkdtemp(path.join(os.tmpdir(), 'pf'));
  const fallbackShort = shortPath(fallback) || fallback;
  if (!usable(fallbackShort)) {
    throw new Error(`No usable short TEMP/TMP path for ${fallback}. Configure a short Windows TEMP path and retry.`);
  }
  return fallbackShort;
}

function python() {
  for (const [command, prefix] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const result = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && result.stdout.trim() === '3') {
      if (command !== 'python3') console.log(`Python fallback: the workflow uses python3; using ${[command, ...prefix].join(' ')} on Windows.`);
      return { command, args: prefix };
    }
  }
  throw new Error('No Python 3 interpreter found (tried python3, python, and py -3).');
}

// A hung app (a main-process error dialog, say) keeps its whole tree alive: stop the tree, as GitHub does at the job limit.
function stopTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function loggedProcess(command, args, env, logFile, timeoutMinutes) {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile);
    let tail = '', launchError, timedOut = null;
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = chunk => { log.write(chunk); tail = (tail + chunk.toString()).slice(-65536); };
    const timer = timeoutMinutes ? setTimeout(() => {
      timedOut = `Stopped after the CI job limit of ${timeoutMinutes} minutes`;
      append(Buffer.from(`\n${timedOut}\n`)); stopTree(child);
    }, timeoutMinutes * 60_000) : null;
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => { launchError = error.message; append(Buffer.from(`${error.message}\n`)); });
    log.on('error', error => { clearTimeout(timer); stopTree(child); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      log.end(() => resolve({ code: timedOut ? 1 : code ?? 1, tail, error: launchError || timedOut || (signal ? `Stopped by ${signal}` : null) }));
    });
  });
}

async function executeLocalStep(step, index, { directory, temp, shell, sha, version, summary }) {
  const name = `${String(index + 1).padStart(2, '0')}-${step.key.replaceAll('/', '-')}`;
  const logFile = path.join(directory, `${name}.log`);
  const base = path.join(temp, `s${String(index + 1).padStart(4, '0')}`);
  const locations = {
    root, temp, profile: path.join(base, 'profile'), codex: path.join(base, 'codex'), claude: path.join(base, 'claude'),
    output: path.join(directory, `${name}.github-output`), summary,
  };
  await Promise.all([locations.profile, locations.codex, locations.claude].map(folder => fsp.mkdir(folder, { recursive: true })));
  await fsp.writeFile(locations.output, '');
  const env = stepEnvironment(process.env, step, locations, sha);
  let dependencies;
  try { dependencies = await fsp.lstat(path.join(root, 'node_modules')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assertPackagingAllowed(step, { linked: dependencies?.isSymbolicLink(), directory: dependencies?.isDirectory() });
  const run = renderRun(step.run, version);
  let command, args;
  if (step.kind === 'python') {
    const interpreter = python();
    command = interpreter.command;
    args = [...interpreter.args, ...pythonCommand(run)];
  } else {
    if (!['pwsh', 'powershell'].includes(step.shell)) throw new Error(`Unsupported local shell: ${step.shell} (${step.name}).`);
    const scriptFile = path.join(directory, `${name}.ps1`);
    // A UTF-8 BOM preserves workflow text in Windows PowerShell 5 as well as PowerShell 7.
    await fsp.writeFile(scriptFile, `\ufeff$ErrorActionPreference = 'Stop'\n${run}\nif ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n`);
    command = shell.command;
    args = [...shell.args, '-File', scriptFile];
  }
  // Read at launch: inside withGuiLock a GUI step's smokes inherit the held lock instead of waiting on it.
  const execute = () => loggedProcess(command, args, process.env.AGENTRIX_GUI_LOCK ? { ...env, AGENTRIX_GUI_LOCK: process.env.AGENTRIX_GUI_LOCK } : env,
    logFile, step.timeoutMinutes);
  const started = Date.now();
  const result = step.kind === 'gui' ? await withGuiLock(`ci-preflight:${step.key}`, execute) : await execute();
  return { ...result, logFile, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

async function local(options, workflow) {
  if (process.platform !== 'win32') throw new Error('Local mode reproduces the Windows job and must run on Windows. Use remote mode for Linux/macOS.');
  const selected = selectSteps(localPlan(workflow), options);
  const extra = options.only ? [] : portablePlan(workflow, selected);
  const steps = [...selected, ...extra];
  const output = path.join(root, '.test-output');
  await fsp.mkdir(output, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(output, `ci-preflight-${Date.now()}-`));
  const shell = powershell();
  const temp = await shortTemporaryDirectory(shell);
  const sha = git(['rev-parse', 'HEAD']);
  const version = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const summary = path.join(directory, 'step-summary.md');
  await fsp.writeFile(summary, '');
  console.log(`Workflow: ${workflowFile}\nLogs: ${directory}\nTEMP/TMP: ${temp}`);
  const nodeVersion = workflow.jobs.windows.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version'];
  if (nodeVersion && Number(String(nodeVersion).split('.')[0]) !== Number(process.versions.node.split('.')[0])) {
    console.warn(`WARNING: workflow Node.js ${nodeVersion}; local Node.js ${process.versions.node}. Runtime installation is skipped.`);
  }
  console.log('Local platform caveat: Linux/macOS Bash, zsh, PTY, packaging and native behavior require the remote runners. Windows Python skips for POSIX, symlinks and Unix sockets are not remote coverage.');
  if (!options.only) console.log('Portable npm test coverage: run once locally, reusing the Windows unit step when selected; Python unittest runs once.');
  if (steps.some(step => step.kind === 'unit' && !step.skip)) {
    console.log('Unit-only deviation: keep an isolated AGENTRIX_DATA_DIR, with AGENTRIX_TEST_HOME=1 and AGENTRIX_TEST_ZOOM=auto for ordinary default assertions. GUI steps keep their CI defaults.');
  }
  const rows = [];
  let failed = false;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.skip) {
      rows.push({ step: step.name, result: 'SKIP', exit: '', seconds: '', detail: step.skip });
      continue;
    }
    console.log(`[${step.number || step.key}] ${step.name}`);
    try {
      const result = await executeLocalStep(step, index, { directory, temp, shell, sha, version, summary });
      rows.push({ step: step.name, result: result.code === 0 ? 'PASS' : 'FAIL', exit: result.code, seconds: result.seconds, detail: result.logFile });
      if (result.code === 0) continue;
      console.error(`Failed (exit ${result.code}): ${step.name}\n${tailLines(result.tail)}`);
    } catch (error) {
      rows.push({ step: step.name, result: 'FAIL', exit: 1, seconds: '', detail: error.message });
      console.error(error.message);
    }
    failed = true;
    for (const remaining of steps.slice(index + 1)) rows.push({ step: remaining.name, result: remaining.skip ? 'SKIP' : 'NOT RUN', exit: '', seconds: '', detail: remaining.skip || 'Stopped after the first failure.' });
    break;
  }
  console.table(rows);
  await fsp.writeFile(path.join(directory, 'results.json'), JSON.stringify({ workflow: workflowFile, sha, temp, rows }, null, 2));
  console.log(`Results: ${path.join(directory, 'results.json')}`);
  return failed ? 1 : 0;
}

function credential(repository) {
  // Capture the helper's output; never include its stdout/stderr in an error, command log, file, or child environment.
  const result = gitResult(['-c', 'credential.interactive=false', 'credential', 'fill'], {
    input: `protocol=https\nhost=github.com\npath=${repository.owner}/${repository.repo}.git\n\n`,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  if (result.error || result.status !== 0) throw new Error('Git credential fill failed; configure an existing GitHub credential before remote preflight.');
  const token = /^password=([^\r\n]+)$/m.exec(result.stdout)?.[1];
  if (!token) throw new Error('Git credential fill did not provide a GitHub token.');
  return token;
}

async function remote(options, workflow) {
  const expected = expectedRemoteJobs(workflow);
  if (!Object.hasOwn(workflow.on || {}, 'workflow_dispatch')) throw new Error('Workflow must enable workflow_dispatch.');
  if (git(['status', '--porcelain'])) throw new Error('Remote preflight requires a clean worktree; only committed HEAD can be tested.');
  const repository = parseOrigin(git(['remote', 'get-url', 'origin']));
  const pushUrls = git(['remote', 'get-url', '--push', '--all', 'origin']).split(/\r?\n/);
  if (pushUrls.length !== 1 || JSON.stringify(parseOrigin(pushUrls[0])) !== JSON.stringify(repository)) {
    throw new Error('Origin must have exactly one push destination matching its GitHub repository.');
  }
  const sha = git(['rev-parse', 'HEAD']);
  const branch = preflightBranch(sha, options.ref);
  const token = credential(repository);
  const redact = value => String(value).replaceAll(token, '[REDACTED]');
  const api = `/repos/${repository.owner}/${repository.repo}`;
  let pushed = false;

  async function request(endpoint, { method = 'GET', body, redirect = 'follow', timeoutMs = 60_000 } = {}) {
    const response = await fetch(`https://api.github.com${api}${endpoint}`, {
      method, redirect, signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Agentrix-ci-preflight' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && response.status !== 302) throw new Error(`GitHub ${method} ${endpoint.split('?')[0]} returned HTTP ${response.status}.`);
    return response;
  }

  async function json(endpoint, options) {
    return (await request(endpoint, options)).json();
  }

  async function jobs(runId) {
    const result = [];
    for (let page = 1; ; page++) {
      const response = await json(`/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
      if (!Array.isArray(response.jobs)) throw new Error('GitHub jobs response is missing jobs.');
      result.push(...response.jobs);
      if (result.length >= response.total_count) return result;
      if (!response.jobs.length) throw new Error('GitHub jobs pagination ended before all jobs were returned.');
    }
  }

  async function printLog(job) {
    try {
      let response = await request(`/actions/jobs/${job.id}/logs`, { redirect: 'manual' });
      if (response.status === 302) {
        const location = response.headers.get('location');
        if (!location || new URL(location).protocol !== 'https:') throw new Error('Missing secure job-log redirect.');
        // Signed storage URLs receive no Authorization header and are never printed or persisted.
        response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      }
      if (!response.ok) throw new Error(`Job log returned HTTP ${response.status}.`);
      console.log(`\n${job.name}: log excerpt\n${redact(await collectLogExcerpt(response.body))}`);
    } catch (error) { console.warn(redact(`${job.name}: log excerpt unavailable: ${error.message}`)); }
  }

  try {
    if (git(['rev-parse', 'HEAD']) !== sha || git(['status', '--porcelain'])) throw new Error('HEAD or worktree changed before the preflight push.');
    const push = gitResult(pushArguments(sha, branch));
    if (push.error || push.status !== 0) throw new Error('Preflight branch creation failed. An existing branch is never overwritten.');
    pushed = true;
    console.log(`Created ${branch} for HEAD ${sha}.`);
    const dispatch = await json(`/actions/workflows/${path.basename(workflowFile)}/dispatches`, {
      method: 'POST', body: { ref: branch, return_run_details: true },
    });
    const runId = dispatch.workflow_run_id;
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Dispatch did not return an exact workflow run ID; refusing to guess a matching run.');
    console.log(`Run: https://github.com/${repository.owner}/${repository.repo}/actions/runs/${runId}`);
    const deadline = Date.now() + 110 * 60_000;
    const run = await pollWorkflowRun(timeoutMs => json(`/actions/runs/${runId}`, { timeoutMs }), {
      deadline,
      inspect: current => {
        verifyDispatchedRun(current, { runId, sha, branch });
        console.log(`${new Date().toISOString()} ${current.status}${current.conclusion ? ` / ${current.conclusion}` : ''}`);
      },
    });
    const completed = await jobs(runId);
    console.table(completed.map(job => ({ job: job.name, status: job.status, conclusion: job.conclusion })));
    const assessment = assessRemoteJobs(completed, expected, run.conclusion);
    for (const job of completed.filter(job => job.conclusion && !['success', 'skipped'].includes(job.conclusion))) await printLog(job);
    if (!assessment.success) throw new Error(`Remote preflight failed:\n${assessment.problems.join('\n')}`);
    const deletion = gitResult(pushArguments(sha, branch, true));
    if (deletion.error || deletion.status !== 0) throw new Error('All jobs passed, but safe branch deletion failed; it may have moved concurrently.');
    console.log(`All required jobs passed; deleted ${branch} at its original SHA.`);
    return 0;
  } catch (error) {
    console.error(redact(error.message));
    if (pushed) console.error(`Kept ${branch} for inspection; no other branch was modified.`);
    return 1;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { console.log(usage); return 0; }
  const workflow = parseWorkflow(await fsp.readFile(path.join(root, workflowFile), 'utf8'));
  return options.mode === 'local' ? local(options, workflow) : remote(options, workflow);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
