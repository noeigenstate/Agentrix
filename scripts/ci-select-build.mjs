import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInstallerArtifactIds, findReusableRun, installerArtifacts } from './ci-preflight-core.mjs';

const readGitHub = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 * 1024,
}));

export async function selectBuild({ currentRun = false, read = readGitHub, env = process.env } = {}) {
  const options = { repository: env.GITHUB_REPOSITORY, sha: env.GITHUB_SHA, runId: Number(env.GITHUB_RUN_ID),
    artifactNames: env.WINDOWS_ONLY === 'true' ? [installerArtifacts[0]] : installerArtifacts };
  if (currentRun) {
    const artifactIds = await findInstallerArtifactIds(read, options);
    if (!artifactIds) throw new Error('The current run has no complete, unexpired installer artifacts.');
    return { runId: options.runId, artifactIds };
  }
  try {
    return await findReusableRun(read, { ...options, requiredJobs: JSON.parse(env.REQUIRED_JOBS) });
  } catch {
    // A failed reuse lookup falls back to all builds/tests; credential-bearing errors must never reach the log.
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--current-run')) throw new Error('Unsupported selection mode.');
  const selected = await selectBuild({ currentRun: args.length === 1 });
  appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${selected?.runId ?? ''}\nartifact-ids=${selected?.artifactIds.join(',') ?? ''}\n`);
  console.log(selected ? `Selected tested artifacts from run ${selected.runId}.` : 'Building and testing this commit.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Unable to select the verified installer artifacts.'); process.exitCode = 1; });
}
