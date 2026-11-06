import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { root, git, planFor, printPlan } from './affected-tests.mjs';

const require = createRequire(import.meta.url);
export function guiForStep(run, manifest, pkg) {
  const runtime = /--runtime\b/.test(run);
  const npm = /\bnpm run ([\w:-]+)/.exec(run)?.[1];
  const command = npm ? pkg.scripts[npm] ?? '' : run;
  return Object.entries(manifest.gui).find(([name, spec]) => command.includes(spec.file) && name.endsWith('-runtime') === runtime)?.[0] ?? null;
}
export async function findFullBetaBaseline({ read, repository, runId, workflowId, workflowPath, guiNames, ancestor }) {
  // Bound API work. No trustworthy, full ancestor in this window means a full run.
  let inspected = 0;
  for (let page = 1; page <= 5; page++) {
    const response = await read(`/repos/${repository}/actions/workflows/build-windows.yml/runs?branch=beta&status=success&per_page=100&page=${page}`);
    if (!Array.isArray(response.workflow_runs) || !Number.isSafeInteger(response.total_count)) return null;
    for (const run of response.workflow_runs) {
      const eligible = candidate => candidate.id !== runId && Number.isSafeInteger(candidate.id) && candidate.id > 0
        && candidate.workflow_id === workflowId && candidate.path?.split('@')[0] === workflowPath
        && candidate.repository?.full_name === repository && candidate.head_repository?.full_name === repository
        && candidate.head_branch === 'beta' && ['push', 'workflow_dispatch'].includes(candidate.event)
        && candidate.status === 'completed' && candidate.conclusion === 'success' && /^[a-f0-9]{40}$/.test(candidate.head_sha)
        && Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0;
      if (!eligible(run) || !ancestor(run.head_sha)) continue;
      if (++inspected > 20) return null;
      const jobs = [];
      for (let jobPage = 1; ; jobPage++) {
        const result = await read(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${jobPage}`);
        if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count)) return null;
        jobs.push(...result.jobs);
        if (jobs.length >= result.total_count) break;
        if (!result.jobs.length) return null;
      }
      const success = item => item?.status === 'completed' && item?.conclusion === 'success';
      const job = name => { const found = jobs.filter(item => item.name === name); return found.length === 1 && success(found[0]) ? found[0] : null; };
      const build = job('Windows x64 build');
      if (!job('Select tested build') || !build || !build.steps?.some(step => step.name === 'Run unit and integration tests' && step.conclusion === 'success')
        || !build.steps?.some(step => step.name === 'Real Claude CLI contract (offline)' && step.conclusion === 'success')) continue;
      const desktop = ['interaction', 'terminals', 'reading'].map(shard => job(`Windows desktop ${shard}`));
      if (desktop.some(item => !item)) continue;
      if (!guiNames.every(name => desktop.flatMap(item => item.steps ?? []).filter(step => step.name === name && step.conclusion === 'success').length === 1)) continue;
      const checked = await read(`/repos/${repository}/actions/runs/${run.id}`);
      if (eligible(checked) && checked.id === run.id && checked.run_attempt === run.run_attempt) return { sha: run.head_sha, runId: run.id };
    }
    if (page * 100 >= response.total_count || !response.workflow_runs.length) break;
  }
  return null;
}

export async function main(env = process.env, read = (endpoint, timeout) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', windowsHide: true, timeout: Math.min(timeout, 30000), maxBuffer: 16 * 1024 * 1024 }))) {
  const workflow = require('js-yaml').load(fs.readFileSync(path.join(root, '.github/workflows/build-windows.yml'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/affected-tests-map.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const guiSteps = workflow.jobs['windows-desktop'].steps.filter(step => step.run && guiForStep(step.run, manifest, pkg));
  if (guiSteps.length !== Object.keys(manifest.gui).length || new Set(guiSteps.map(step => guiForStep(step.run, manifest, pkg))).size !== guiSteps.length) throw new Error('Incomplete GUI workflow mapping');
  const selective = env.GITHUB_REF === 'refs/heads/beta' && env.AFFECTED_FULL_MATRIX !== 'true' && ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME);
  let baseline = null, reason = selective ? 'No verified full green beta ancestor' : 'Stable, tag or full_matrix: full coverage required';
  if (selective) {
    try {
      const deadline = Date.now() + 45000;
      const boundedRead = endpoint => { const left = deadline - Date.now(); if (left <= 0) throw new Error('Baseline lookup deadline'); return read(endpoint, left); };
      const current = await boundedRead(`/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
      if (current.head_sha !== env.GITHUB_SHA || current.id !== Number(env.GITHUB_RUN_ID) || !Number.isSafeInteger(current.workflow_id)) throw new Error('Workflow identity mismatch');
      baseline = await findFullBetaBaseline({ read: boundedRead, repository: env.GITHUB_REPOSITORY, runId: current.id, workflowId: current.workflow_id,
        workflowPath: '.github/workflows/build-windows.yml', guiNames: guiSteps.map(step => step.name), ancestor: sha => {
          try { git(['merge-base', '--is-ancestor', sha, env.GITHUB_SHA]); return true; } catch { return false; }
        } });
    } catch { reason = 'Baseline lookup failed; full coverage required'; }
  }
  const { plan } = planFor({ base: baseline?.sha, head: env.GITHUB_SHA, full: baseline ? null : reason });
  plan.baselineRun = baseline?.runId ?? null;
  printPlan(plan);
  for (const shard of ['interaction', 'terminals', 'reading']) console.log(`${shard}: ${plan.shards.includes(shard) ? 'RUN affected suites' : 'SKIP: no affected module since the verified full baseline'}`);
  fs.mkdirSync(path.join(root, '.test-output'), { recursive: true });
  fs.writeFileSync(path.join(root, '.test-output/affected-tests.json'), JSON.stringify(plan, null, 2) + '\n');
  fs.appendFileSync(env.GITHUB_OUTPUT, `full=${plan.full}\nreal=${plan.real.length > 0}\ngui=${JSON.stringify(plan.gui)}\nshards=${JSON.stringify(plan.shards)}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n### Affected tests\nBase: ${plan.base ?? 'none (full)'}; baseline run: ${plan.baselineRun ?? 'none'}.\n\nUnit: ${plan.unit.length}; real CLI: ${plan.real.length}; GUI: ${plan.gui.join(', ') || 'none'}.\n\n${plan.fullReasons.join('\n')}\n`);
  return plan;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Unable to produce an affected-test plan; no tests may be skipped.'); process.exitCode = 1; });
}
