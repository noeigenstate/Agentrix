const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
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
