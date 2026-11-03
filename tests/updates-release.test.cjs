const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { spawnSync } = require('node:child_process');
const { BETA_AGREEMENT_VERSION } = require('../electron/updates.cjs');

test('main and renderer require the same beta agreement version', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/features/settings/beta-agreement.ts'), 'utf8');
  const match = source.match(/^export const BETA_AGREEMENT_VERSION = '([^']+)';?\s*$/m);
  assert(match, 'the renderer exports the required agreement version');
  assert.equal(match[1], BETA_AGREEMENT_VERSION);
});

test('beta release versions are accepted by release notes and the workflow version guards', async () => {
  const { releaseNotes } = await import('../scripts/release-notes.mjs');
  const version = '1.3.27-beta.1';
  assert.match(releaseNotes([{ title: 'Title', text: 'Text' }], { Title: 'Title', Text: 'Text' }, version), /^## Changes in 1\.3\.27-beta\.1/);
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const windows = workflow.jobs.windows.steps.find(step => step.name === 'Validate release version').run;
  const pattern = windows.match(/\$version -notmatch '([^']+)'/)[1];
  assert(new RegExp(pattern).test(version));
  assert(windows.includes('$env:GITHUB_REF_NAME -ne "v$version"'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert(workflow.on.push.tags.includes('v*'));
  for (const job of ['macos', 'linux']) {
    const validation = workflow.jobs[job].steps.find(step => step.id === 'version').run;
    assert(new RegExp(validation.match(/\$version =~ (\S+) /)[1]).test(version));
    assert(validation.includes('$GITHUB_REF_NAME != "v$version"'));
  }
});

test('the prerelease workflow requires and uploads the feed, installer and blockmap', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const assets = workflow.jobs.windows.steps.find(step => step.name === 'Upload verified executable').with.path;
  for (const file of ['release/Agentrix-Setup-*.exe', 'release/Agentrix-Setup-*.exe.blockmap', 'release/latest.yml']) assert(assets.includes(file));
  const verify = workflow.jobs.release.steps.find(step => step.name === 'Verify release assets and prepare notes').run;
  for (const file of ['"$RELEASE_INSTALLER"', '"$RELEASE_INSTALLER.blockmap"', 'latest.yml']) assert(verify.includes(`test -f ${file}`));
  const publish = workflow.jobs.release.steps.find(step => step.name === 'Publish verified release assets').run;
  assert(publish.includes('if [[ "$RELEASE_VERSION" == *-* ]]; then flags=(--prerelease --latest=false); fi'));
  assert(publish.includes('($installer + ".blockmap")'), 'published-release reruns also verify the blockmap');
});

function releaseBody(version) {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const verify = workflow.jobs.release.steps.find(step => step.name === 'Verify release assets and prepare notes').run;
  const start = verify.indexOf('\n', verify.indexOf('assets=('));
  const end = verify.indexOf('\nEOF', start);
  assert(start >= 0 && end > start, 'the workflow includes the release body heredoc');
  // Execute only the body setup and heredoc, without artifact reads, downloads or release commands.
  const source = verify.slice(start, end + '\nEOF'.length), heredoc = 'cat > release-notes.md <<EOF';
  assert.equal(source.split(heredoc).length, 2, 'the body redirect is replaced before executing the shell');
  const script = source.replace(heredoc, 'cat <<EOF');
  const result = spawnSync(process.env.AGENTRIX_TEST_BASH || 'bash', ['-c', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RELEASE_VERSION: version, RELEASE_INSTALLER: `Agentrix-Setup-${version}-x64.exe`, MAC_IMAGE: `Agentrix-${version}-mac-arm64.dmg`,
      changes: `## Changes in ${version}`, GITHUB_SHA: 'a'.repeat(40), GH_REPO: 'owner/repository', BUILD_RUN_ID: '123' },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return result.stdout;
}

function macVersionFromCommand(body) {
  const command = body.split('\n').find(line => line.startsWith('curl -fsSL '));
  assert(command, 'release notes include the macOS installer command');
  // The downloaded script is local fixture text: running the command must pass the version to bash, not curl.
  const script = ['curl() {', "cat <<'INSTALLER'", 'printf \'%s\' "${AGENTRIX_VERSION:-latest}"', 'INSTALLER', '}', command].join('\n');
  const env = { ...process.env };
  delete env.AGENTRIX_VERSION;
  const result = spawnSync(process.env.AGENTRIX_TEST_BASH || 'bash', ['-c', script], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return { command, version: result.stdout };
}

test('beta release bodies identify a test build and their macOS command installs that beta', () => {
  const version = '1.3.27-beta.1', body = releaseBody(version);
  assert.match(body, /^\*\*Test build:\*\*.*unstable.*Stable.*Beta.*agreement/);
  const install = macVersionFromCommand(body);
  assert.match(install.command, /\| AGENTRIX_VERSION=1\.3\.27-beta\.1 bash$/);
  assert.equal(install.version, version);
});

test('stable release bodies keep their original introduction and unpinned macOS command', () => {
  const body = releaseBody('1.3.27');
  assert(body.startsWith('The Windows x64 installer of Agentrix, a macOS edition for Apple silicon, and Linux editions for x64 and arm64.\n'));
  assert.doesNotMatch(body, /Test build:|prerelease|AGENTRIX_VERSION=/);
  const install = macVersionFromCommand(body);
  assert.equal(install.command, 'curl -fsSL https://raw.githubusercontent.com/noeigenstate/Agentrix/main/scripts/install-macos.sh | bash');
  assert.equal(install.version, 'latest');
});
