import yaml from 'js-yaml';

export const workflowFile = '.github/workflows/build-windows.yml';

export function parseWorkflow(source) {
  const workflow = yaml.load(source);
  if (!workflow?.jobs?.windows?.steps) throw new Error('The workflow has no Windows steps.');
  return workflow;
}

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isNpmTest = run => /^\s*npm test\s*$/m.test(run || '');

function skipReason(step) {
  if (step.uses) {
    if (step.uses.startsWith('actions/checkout@')) return 'Use the current checkout; no checkout or reset.';
    if (step.uses.startsWith('actions/setup-node@')) return 'Use the installed Node.js; no runtime installation.';
    if (step.uses.startsWith('actions/upload-artifact@')) return 'Keep local artifacts and logs; no upload.';
    throw new Error(`Unsupported workflow action in ${step.name}: ${step.uses}`);
  }
  if (step.id === 'version' && step.name === 'Validate release version') return 'Skip release/tag validation; supply the package version locally.';
  if (/^\s*npm ci\b/m.test(step.run || '')) return 'Use installed locked dependencies; no npm ci.';
  if (/\bnpm\s+(?:install|i)\s+[^\r\n]*(?:--global|-g)(?=\s|$)/.test(step.run || '')) return 'Use installed CLIs; no global installation.';
  if (typeof step.run !== 'string' || !step.run.trim()) throw new Error(`Missing run command in ${step.name}.`);
  return null;
}

export function localPlan(workflow) {
  const job = workflow.jobs.windows;
  return job.steps.map((step, index) => ({
    number: index + 1,
    key: `windows/${slug(step.name || `step-${index + 1}`)}`,
    name: step.name || `Step ${index + 1}`,
    run: step.run || '',
    shell: step.shell || job.defaults?.run?.shell || workflow.defaults?.run?.shell || 'pwsh',
    env: { ...workflow.env, ...job.env, ...step.env },
    skip: skipReason(step),
    // GitHub cancels the whole job at this limit, so no local step may outlast it.
    timeoutMinutes: step['timeout-minutes'] ?? job['timeout-minutes'] ?? null,
    kind: isNpmTest(step.run) ? 'unit' : /\bnpm run test:|\bnode scripts\/[\w-]+-smoke\.mjs\b/.test(step.run || '') ? 'gui' : 'command',
  }));
}

export function selectSteps(steps, { from, only } = {}) {
  if (from && only) throw new Error('--from and --only cannot be combined.');
  const selector = from || only;
  if (!selector) return steps;
  const value = selector.toLowerCase().trim();
  const exact = step => [String(step.number), step.key, step.name, step.run.trim()].some(item => item.toLowerCase() === value);
  let matches = steps.filter(exact);
  if (!matches.length) matches = steps.filter(step => step.key.includes(value) || step.name.toLowerCase().includes(value));
  if (matches.length !== 1) throw new Error(`Step selector must match exactly one step: ${selector} (${matches.length} matches).`);
  return only ? matches : steps.slice(steps.indexOf(matches[0]));
}

export function portablePlan(workflow, selected) {
  for (const id of ['linux', 'macos']) {
    const matches = workflow.jobs[id]?.steps?.filter(step => isNpmTest(step.run));
    if (matches?.length !== 1) throw new Error(`Expected one npm test command in ${id}.`);
  }
  const python = workflow.jobs['remote-linux']?.steps?.filter(step => /^\s*python3? -m unittest\b/.test(step.run || ''));
  if (python?.length !== 1) throw new Error('Expected one remote-linux Python unittest command.');
  const env = { ...workflow.env, ...workflow.jobs.windows.env };
  const steps = selected.some(step => !step.skip && step.kind === 'unit') ? [] : [{
    key: 'portable/npm-test', name: 'Shared Linux/macOS npm test (on this host)', run: 'npm test', shell: 'pwsh', env, kind: 'unit', skip: null,
  }];
  return [...steps, {
    key: 'remote-linux/python-unittest', name: python[0].name, run: python[0].run, shell: 'python',
    env: { ...env, ...workflow.jobs['remote-linux'].env, ...python[0].env }, kind: 'python', skip: null,
  }];
}

export function renderRun(run, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid local package version.');
  const result = run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    if (expression === 'steps.version.outputs.version') return version;
    throw new Error(`Unsupported GitHub expression: ${expression}`);
  });
  if (result.includes('${{')) throw new Error('Malformed GitHub expression in run command.');
  return result;
}

export function stepEnvironment(base, step, locations, sha) {
  // The 8.3 short TEMP reproduces the Windows runner only; a step from a Linux job keeps this host's own TEMP (Linux has
  // no short names, and its paths compared against long ones would fail here for a reason CI never meets).
  const temp = step.key?.startsWith('remote-linux/') ? {} : { TEMP: locations.temp, TMP: locations.temp, RUNNER_TEMP: locations.temp };
  const values = {
    ...step.env, CI: 'true', AGENTRIX_TEST_TIMEOUT_SCALE: step.env?.AGENTRIX_TEST_TIMEOUT_SCALE ?? '2', ...temp,
    AGENTRIX_DATA_DIR: locations.profile, CODEX_HOME: locations.codex, CLAUDE_CONFIG_DIR: locations.claude,
    GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/ci/local-preflight', GITHUB_REF_NAME: 'ci/local-preflight', GITHUB_REF_TYPE: 'branch',
    GITHUB_WORKSPACE: locations.root, GITHUB_OUTPUT: locations.output, GITHUB_STEP_SUMMARY: locations.summary,
  };
  // These existing opt-ins keep ordinary unit defaults while the profile remains isolated.
  if (step.kind === 'unit') Object.assign(values, { AGENTRIX_TEST_HOME: '1', AGENTRIX_TEST_ZOOM: 'auto' });
  const replaced = new Set([...Object.keys(values), 'AGENTRIX_TEST_HOME', 'AGENTRIX_TEST_ZOOM'].map(key => key.toUpperCase()));
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !replaced.has(key.toUpperCase())));
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

export function assertPackagingAllowed(step, { linked, directory }) {
  if (!/\bnpm run dist(?::[\w-]+)?\b/.test(step.run)) return;
  if (linked) throw new Error('Packaging refused: node_modules is a symlink/junction. Run from a checkout with a real node_modules directory.');
  if (!directory) throw new Error('Packaging refused: node_modules must be an installed real directory.');
}

export function pythonCommand(run) {
  if (!/^python3?\s+/.test(run) || /[\r\n;|&<>`$]/.test(run)) throw new Error('Unsupported Python workflow command.');
  const words = run.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) || [];
  if (words.join(' ').replace(/\s+/g, ' ') !== run.trim().replace(/\s+/g, ' ')) throw new Error('Unsupported quoting in Python workflow command.');
  return words.slice(1).map(word => /^['"]/.test(word) ? word.slice(1, -1) : word);
}

export function parseOrigin(origin) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin.trim());
  if (!match || ['.', '..'].includes(match[2])) throw new Error('Origin must be an ordinary GitHub HTTPS or SSH repository URL without embedded credentials.');
  return { owner: match[1], repo: match[2] };
}

export function preflightBranch(sha, destination) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Preflight requires a full lowercase HEAD SHA.');
  const branch = destination ?? `ci/preflight-${sha.slice(0, 12)}`;
  if (!/^ci\/preflight-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(branch)) {
    throw new Error('Refusing a push outside a safe ci/preflight-* branch (lowercase letters, numbers and hyphens only).');
  }
  return branch;
}

export function pushArguments(sha, branch, remove = false) {
  const ref = `refs/heads/${preflightBranch(sha, branch)}`;
  // Empty expected value creates only a missing branch; deletion compares the exact original SHA atomically.
  return ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:${remove ? sha : ''}`, 'origin', remove ? `:${ref}` : `${sha}:${ref}`];
}

export function expectedRemoteJobs(workflow) {
  for (const id of ['windows', 'macos', 'linux', 'remote-linux', 'release']) {
    if (!workflow.jobs[id]) throw new Error(`Required workflow job is missing: ${id}`);
  }
  const guard = workflow.jobs.release.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  if (!/^startsWith\(github\.ref,\s*'refs\/tags\/v'\)$/.test(guard || '')) throw new Error('Release must remain restricted to version tags before remote preflight.');
  const expected = [];
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const matrix = job.strategy?.matrix;
    if (matrix && (!Array.isArray(matrix.include) || Object.keys(matrix).some(key => key !== 'include'))) {
      throw new Error(`Unsupported matrix in ${id}; cannot verify every job safely.`);
    }
    const entries = matrix ? matrix.include : [{}];
    if (!entries.length) throw new Error(`Empty matrix in ${id}.`);
    for (const entry of entries) {
      const name = (job.name || id).replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, key) => {
        if (!Object.hasOwn(entry, key)) throw new Error(`Unknown matrix name field in ${id}: ${key}`);
        return String(entry[key]);
      });
      if (name.includes('${{')) throw new Error(`Unsupported job name expression in ${id}.`);
      expected.push({ name, conclusion: id === 'release' ? 'skipped' : 'success' });
    }
  }
  if (new Set(expected.map(job => job.name)).size !== expected.length) throw new Error('Workflow job names must be unique for remote verification.');
  return expected;
}

export function verifyDispatchedRun(run, { runId, sha, branch }) {
  const canonicalPath = typeof run.path === 'string' ? run.path.split('@', 1)[0] : null;
  if (run.id !== runId || run.head_sha !== sha || run.head_branch !== branch || run.event !== 'workflow_dispatch' || canonicalPath !== workflowFile) {
    throw new Error('Dispatched workflow identity does not match the returned run ID, HEAD, branch and workflow.');
  }
}

export async function pollWorkflowRun(readRun, { deadline, inspect, now = Date.now, wait = delay => new Promise(resolve => setTimeout(resolve, delay)) }) {
  const remaining = () => {
    const duration = deadline - now();
    if (duration <= 0) throw new Error('Workflow did not finish within 110 minutes.');
    return duration;
  };
  for (;;) {
    let run;
    try { run = await readRun(Math.min(60_000, remaining())); }
    catch (error) { remaining(); throw error; }
    remaining();
    inspect(run);
    if (run.status === 'completed') return run;
    await wait(Math.min(30_000, remaining()));
  }
}

export function assessRemoteJobs(jobs, expected, conclusion) {
  const problems = [];
  for (const entry of expected) {
    const matches = jobs.filter(job => job.name === entry.name);
    if (matches.length !== 1) problems.push(`${entry.name}: expected one job, found ${matches.length}`);
    else if (matches[0].status !== 'completed' || matches[0].conclusion !== entry.conclusion) {
      problems.push(`${entry.name}: ${matches[0].conclusion || matches[0].status}, expected ${entry.conclusion}`);
    }
  }
  for (const job of jobs) {
    if (!expected.some(entry => entry.name === job.name) && (job.status !== 'completed' || job.conclusion !== 'success')) {
      problems.push(`${job.name}: unexpected job did not succeed`);
    }
  }
  if (conclusion !== 'success') problems.push(`Workflow conclusion: ${conclusion || 'unknown'}`);
  return { success: problems.length === 0, problems };
}

export function tailLines(value, count = 40) {
  return value.trimEnd().split(/\r?\n/).slice(-count).join('\n');
}

export async function collectLogExcerpt(chunks) {
  const decoder = new TextDecoder();
  const before = [], tail = [], groups = [];
  let pending = '', following = 0;
  const addLine = line => {
    const match = /Error:|Timed out|not ok/i.exec(line);
    const displayed = line.length <= 4000 ? line : `...${line.slice(Math.max(0, (match?.index ?? line.length) - 1000), Math.max(0, (match?.index ?? line.length) - 1000) + 4000)}`;
    if (following > 0) { groups.at(-1).push(displayed); following--; }
    else if (match) {
      groups.push([...before, displayed]);
      if (groups.length > 8) groups.shift();
      following = 3;
    }
    before.push(displayed); if (before.length > 3) before.shift();
    tail.push(displayed); if (tail.length > 40) tail.shift();
  };
  for await (const chunk of chunks) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) addLine(line);
    // A malformed log without newlines must not grow memory without bound.
    if (pending.length > 65536) { addLine(pending); pending = pending.slice(-64); }
  }
  pending += decoder.decode();
  if (pending) addLine(pending);
  return `${groups.length ? `Error context (up to 8 matches):\n${groups.map(group => group.join('\n')).join('\n...\n')}\n\n` : ''}Log tail:\n${tail.join('\n')}`;
}

export function parseArguments(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [mode, ...args] = argv;
  if (!['local', 'remote'].includes(mode)) throw new Error('Choose local or remote mode.');
  const options = { mode };
  while (args.length) {
    const flag = args.shift();
    if (!['--from', '--only', '--ref'].includes(flag) || !args[0] || args[0].startsWith('--')) throw new Error(`Invalid option: ${flag}`);
    const key = flag.slice(2);
    if (options[key]) throw new Error(`Repeated option: ${flag}`);
    options[key] = args.shift();
  }
  if (options.from && options.only) throw new Error('--from and --only cannot be combined.');
  if (mode === 'remote' && (options.from || options.only)) throw new Error('Remote mode always runs the complete workflow.');
  if (mode === 'local' && options.ref) throw new Error('--ref is a remote destination branch option.');
  return options;
}
