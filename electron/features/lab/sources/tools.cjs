// What a task source may use of the machine, handed to it as ctx.tools: git, workspaces, test reports and pinned
// downloads. Providers never spawn or fetch on their own; a test injects fakes here instead of touching the network.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fs } = require('../disk.cjs');
const { git } = require('../process.cjs');
const { safePath } = require('../history.cjs');
const { testResult: tap } = require('../grading.cjs');
const { prepareWorktree, initBaseline, validateLinks } = require('../workspace.cjs');

// The owner's revision as a private workspace in directory/worktree: an archive, its dependencies and a fresh baseline.
const snapshot = (projectPath, directory, revision, { signal, electronDist = false } = {}) =>
  prepareWorktree(projectPath, directory, { base: revision }, signal, { electronDist });

// A folder the provider filled (a checkout without .git, an unpacked task) as a workspace: every file outside exclude
// (top-level names such as a venv, kept out of git) becomes the baseline.
async function files(cwd, { signal, exclude = [] } = {}) {
  const real = await fs.realpath(cwd);
  await validateLinks(real);
  const names = (await fs.readdir(real, { recursive: true, withFileTypes: true })).filter(entry => !entry.isDirectory())
    .map(entry => path.relative(real, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(file => !exclude.some(name => file === name || file.startsWith(name + '/')));
  if (names.some(file => !safePath(file))) throw new Error('The workspace contains an unsafe path.');
  const baseline = await initBaseline(real, names, signal, { exclude });
  return { cwd: real, baseline, real, gitDirectory: path.join(real, '.git'), files: names };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = text => text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(\w+));/gi, (match, hex, decimal, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : decimal ? String.fromCodePoint(Number(decimal)) : ENTITIES[name] ?? match);

// pytest's --junitxml report, one entry per test case. A report without a test case proves nothing, so it throws.
function junit(xml) {
  const cases = [...String(xml).matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, head, body = '']) => {
    const fields = Object.fromEntries([...head.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]));
    const outcome = /<error\b/.test(body) ? 'error' : /<failure\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    return { classname: fields.classname ?? '', name: fields.name ?? '', file: fields.file ?? null, outcome };
  });
  if (!/<testsuite\b/.test(xml) || !cases.length) throw new Error('测试报告无法读取，请查看测试日志。');
  return { cases, testsTotal: cases.length, testsPassed: cases.filter(entry => entry.outcome === 'passed').length };
}

async function hashFile(file) {
  const hash = createHash('sha256'), handle = await fs.open(file);
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

const pending = (name, owner) => async () => { throw new Error(`tools.${name} is not implemented yet (${owner}).`); };

module.exports = {
  // git(cwd, args, { signal, raw }) → stdout; hooks, fsmonitor and the owner's git configuration are off.
  git,
  snapshot,
  files,
  // tap(output, exitCode, reference?) → { testsPassed, testsTotal, names }; node --test TAP that did not fully run throws.
  tap,
  junit,
  // safePath(file) → boolean: a relative posix path without '..', '.git', control characters, '\\' or ':'.
  safePath,
  hashFile,
  // fetchCommit(url, commit, destination, { signal, hosts }) → Promise<void>: a bare mirror of url in destination with
  // commit present. https only, url's host in hosts, GIT_ALLOW_PROTOCOL=https, cleanEnvironment, no credential helper.
  fetchCommit: pending('fetchCommit', 'L1'),
  // download(url, destination, { signal, hosts, sha256, maxBytes }) → Promise<{ bytes }>: https only, host allow-list,
  // no credentials; the file appears at destination only when its sha256 matches.
  download: pending('download', 'L1'),
  docker: {
    // probe({ signal }) → Promise<{ available: boolean, reason: string | null }>; never throws for a missing Docker.
    probe: pending('docker.probe', 'L1'),
    // run({ image, workdir, mount, command, network, timeoutMs, log, signal }) → Promise<{ code, stdout, stderr }>:
    // mount is the one host folder (read-write at workdir); no other host mount, socket or credential; network false
    // unless the phase allows it; the container is removed when it ends or the signal aborts.
    run: pending('docker.run', 'L1'),
  },
};
