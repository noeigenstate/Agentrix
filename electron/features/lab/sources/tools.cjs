// What a task source may use of the machine, handed to it as ctx.tools: git, workspaces, test reports and pinned
// downloads. Providers never spawn or fetch on their own; a test injects fakes here instead of touching the network.
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { fs, removePath } = require('../disk.cjs');
const { git, stopTree, aborted } = require('../process.cjs');
const { cleanEnvironment } = require('../sandbox.cjs');
const { safePath } = require('../history.cjs');
const { testResult: tap } = require('../grading.cjs');
const { prepareWorktree, initBaseline, validateLinks } = require('../workspace.cjs');

// The owner's revision as a private workspace in directory/worktree: an archive, its dependencies and a fresh baseline.
const snapshot = (projectPath, directory, revision, { signal, electronDist = false, exclude = [] } = {}) =>
  prepareWorktree(projectPath, directory, { base: revision }, signal, { electronDist, exclude });

// A folder the provider filled (a checkout without .git, an unpacked task) as a workspace: every file outside exclude
// (workspace-relative folders such as a venv, kept out of git) becomes the baseline.
async function files(cwd, { signal, exclude = [] } = {}) {
  const real = await fs.realpath(cwd), names = [];
  await validateLinks(real, real, { exclude, signal, onFile: file => names.push(file) });
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

const infrastructure = message => Object.assign(new Error(message), { infrastructure: true });

// Unlike process.command, this trusted host runner keeps its explicitly restricted Git protocol environment.
async function hostCommand(file, args, { env, signal, timeoutMs = 120000, stdin = '', cwd } = {}) {
  aborted(signal);
  const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, failure, stopping;
  const stop = error => { failure ||= error; stopping ||= stopTree(child); };
  const abort = () => stop(infrastructure('实验已停止。'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => stop(infrastructure('实验运行超时。')), timeoutMs);
  child.stdin.on('error', () => {}); child.stdin.end(stdin);
  for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.setEncoding('utf8'); stream.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) return stop(infrastructure('实验日志超过大小限制。'));
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
    });
  }
  try {
    const code = await new Promise(resolve => {
      child.once('error', () => { failure ||= infrastructure('无法启动实验工具。'); });
      child.once('close', resolve);
    });
    await stopping;
    if (failure) throw failure;
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function allowedUrl(value, hosts) {
  let url;
  try { url = new URL(value); } catch { throw infrastructure('无效的实验下载地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' ||
    !Array.isArray(hosts) || !hosts.some(host => host.toLowerCase() === url.hostname.toLowerCase())) {
    throw infrastructure('实验下载地址不在允许范围内。');
  }
  return url;
}

function createTools({ command = hostCommand, get = https.get, now = () => new Date().toISOString() } = {}) {
  const fetches = new Map(), containers = new Set(), removed = new Set();
  const environment = async operation => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-lab-tool-'));
    const env = { ...cleanEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home, DOCKER_CONFIG: home, GIT_ALLOW_PROTOCOL: 'https' };
    try { return await operation(env); } finally { await removePath(home); }
  };
  const response = async (url, { hosts, signal, headers = {}, redirects = 4 } = {}) => {
    for (let count = 0; ; count++) {
      aborted(signal); url = allowedUrl(url, hosts);
      const reply = await new Promise((resolve, reject) => {
        const request = get(url, { signal, headers }, reply => { reply.on('error', () => {}); resolve(reply); });
        const timer = setTimeout(() => request.destroy(infrastructure('实验下载超时。')), 30000);
        request.once('close', () => clearTimeout(timer));
        request.once('error', () => { clearTimeout(timer); reject(infrastructure('实验下载失败。')); });
      });
      if ([301, 302, 303, 307, 308].includes(reply.statusCode)) {
        reply.resume();
        if (count >= redirects || !reply.headers.location) throw infrastructure('实验下载重定向无效。');
        url = new URL(reply.headers.location, url); continue;
      }
      if (reply.statusCode !== 200) { reply.resume(); throw infrastructure('实验下载失败。'); }
      return reply;
    }
  };
  async function download(url, destination, { signal, hosts, sha256, maxBytes = 512 * 1024 * 1024 } = {}) {
    allowedUrl(url, hosts);
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 ** 3) {
      throw infrastructure('实验下载校验条件无效。');
    }
    const target = path.resolve(destination), temporary = target + '.tmp-' + randomUUID();
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (stat && !stat.isFile()) throw infrastructure('实验下载目标无效。');
    let handle, reply;
    try {
      reply = await response(url, { hosts, signal });
      if (Number(reply.headers['content-length']) > maxBytes) throw infrastructure('实验下载超过大小限制。');
      handle = await fs.open(temporary, 'wx', 0o600);
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of reply) {
        aborted(signal); bytes += chunk.length;
        if (bytes > maxBytes) throw infrastructure('实验下载超过大小限制。');
        hash.update(chunk); await handle.write(chunk);
      }
      if (hash.digest('hex') !== sha256) throw infrastructure('实验下载校验失败。');
      await handle.close(); handle = null; await fs.rename(temporary, target); return { bytes };
    } catch (error) { throw error.infrastructure ? error : infrastructure('实验下载失败。'); }
    finally { reply?.destroy(); await handle?.close(); await fs.rm(temporary, { force: true }); }
  }
  function fetchCommit(url, commit, destination, { signal, hosts } = {}) {
    allowedUrl(url, hosts);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return Promise.reject(infrastructure('无效的实验提交。'));
    const target = path.resolve(destination), pending = fetches.get(target) || Promise.resolve();
    const operation = pending.catch(() => {}).then(() => environment(async env => {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw infrastructure('实验下载目标无效。');
      const run = async args => {
        const result = await command('git', ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
          '-c', 'core.askPass=', '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never',
          '-c', 'protocol.https.allow=always', ...args], { env, signal });
        if (result.code !== 0) throw infrastructure('无法下载固定版本的实验代码。');
        return result.stdout.trim();
      };
      if (!stat) await run(['init', '--bare', ...(commit.length === 64 ? ['--object-format=sha256'] : []), target]);
      if (await run(['-C', target, 'rev-parse', '--is-bare-repository']) !== 'true') throw infrastructure('实验代码缓存无效。');
      await run(['-C', target, 'fetch', '--no-tags', '--depth=1', '--force', String(url), commit]);
      if (await run(['-C', target, 'rev-parse', '--verify', commit + '^{commit}']) !== commit) throw infrastructure('实验代码版本校验失败。');
    }));
    fetches.set(target, operation);
    return operation.finally(() => { if (fetches.get(target) === operation) fetches.delete(target); });
  }
  // https://artificialanalysis.ai/data-api/docs/reference — Pro list endpoint, paginated per-model benchmark values.
  async function aaScores({ key, benchmark, signal }) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(key) || benchmark !== 'terminal-bench-4') {
      throw infrastructure('无法获取 AA 参考分数。');
    }
    const values = {};
    try {
      for (let page = 1; page <= 20; page++) {
        const reply = await response('https://artificialanalysis.ai/api/v2/language/models?page=' + page,
          { hosts: ['artificialanalysis.ai'], signal, headers: { 'x-api-key': key }, redirects: 0 });
        const chunks = []; let size = 0;
        for await (const chunk of reply) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { reply.destroy(); throw new Error(); }
          chunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(data.data) || !['pro', 'commercial'].includes(data.tier)) throw new Error();
        for (const model of data.data) {
          const score = model.evaluations?.terminalbench_v4_0;
          if (/^[a-z0-9][a-z0-9._-]{0,159}$/.test(model.slug) && Number.isFinite(score) && score >= 0 && score <= 1) {
            values[model.slug] = score;
          }
        }
        if (data.pagination?.has_more !== true) return { asOf: now(), values };
      }
      throw new Error();
    } catch { throw infrastructure('无法获取 AA 参考分数。'); }
  }
  const dockerCommand = (args, timeoutMs = 120000) => environment(async env => {
    try { return await command('docker', args, { env, timeoutMs }); }
    catch { throw infrastructure('Docker 操作失败。'); }
  });
  const checkedDocker = async (args, timeoutMs) => {
    const result = await dockerCommand(args, timeoutMs);
    if (result.code !== 0) throw infrastructure('Docker 操作失败。');
    return result;
  };
  const containerId = id => {
    if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id) || !containers.has(id)) throw infrastructure('无效的实验容器。');
    return id;
  };
  const containerPath = file => {
    if (typeof file !== 'string' || !file.startsWith('/') || /[\x00-\x1f\\:]/.test(file) || file.split('/').includes('..')) {
      throw infrastructure('无效的实验容器路径。');
    }
    return file;
  };
  const docker = {
    async probe() {
      try { await checkedDocker(['info', '--format', '{{.ServerVersion}}'], 5000); return { available: true, reason: null }; }
      catch { return { available: false, reason: 'Docker 不可用，请先安装并启动 Docker。' }; }
    },
    async create({ image, digest, workdir, network }) {
      if (typeof image !== 'string' || !/^[a-z0-9][a-z0-9./:_-]{0,240}$/.test(image) ||
        !/^sha256:[a-f0-9]{64}$/.test(digest) || !['none', 'bridge'].includes(network)) throw infrastructure('无效的实验容器配置。');
      containerPath(workdir);
      const name = 'agentrix-lab-' + randomUUID(); let id;
      try {
        const result = await checkedDocker(['create', '--pull=missing', '--name', name, '--label', 'agentrix.lab=true',
          '--network', network, '--workdir', workdir, '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
          '--pids-limit=256', '--entrypoint', '/bin/sh', image + '@' + digest,
          '-c', "trap 'exit 0' TERM INT; while :; do sleep 60; done"]);
        id = result.stdout.trim();
        if (!/^[a-f0-9]{12,64}$/.test(id)) throw infrastructure('Docker 操作失败。');
        containers.add(id); await checkedDocker(['start', id]); return id;
      } catch (error) {
        await dockerCommand(['rm', '--force', id || name]).catch(() => {}); if (id) containers.delete(id); throw error;
      }
    },
    async exec(id, argv, { timeoutMs = 120000, stdin = '' } = {}) {
      containerId(id);
      if (!Array.isArray(argv) || !argv.length || argv.length > 128 ||
        argv.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) ||
        typeof stdin !== 'string' || Buffer.byteLength(stdin) > 256 * 1024 ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60000) throw infrastructure('无效的容器命令。');
      let result;
      try { result = await environment(async env => command('docker', ['exec', '-i', id, ...argv], { env, timeoutMs, stdin })); }
      catch { await docker.remove(id).catch(() => {}); throw infrastructure('Docker 操作失败。'); }
      if (result.code === null || /Error response from daemon|Cannot connect to the Docker daemon|OCI runtime exec failed/i.test(result.stderr)) {
        throw infrastructure('Docker 操作失败。');
      }
      return result;
    },
    async copyTo(id, hostPath, destination) {
      containerId(id); containerPath(destination);
      const stat = await fs.lstat(hostPath);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw infrastructure('无效的容器复制路径。');
      if (stat.isDirectory()) await validateLinks(hostPath);
      await checkedDocker(['cp', path.resolve(hostPath), id + ':' + destination]);
    },
    async copyFrom(id, source, hostPath) {
      containerId(id); containerPath(source);
      const target = path.resolve(hostPath), stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat?.isSymbolicLink()) throw infrastructure('无效的容器复制路径。');
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await checkedDocker(['cp', id + ':' + source, target]);
      const copied = await fs.lstat(target);
      if (copied.isSymbolicLink() || !copied.isFile() && !copied.isDirectory()) {
        await removePath(target); throw infrastructure('无效的容器复制路径。');
      }
      if (copied.isDirectory()) await validateLinks(target);
    },
    async remove(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)) throw infrastructure('无效的实验容器。');
      if (removed.has(id)) return;
      if (!containers.has(id)) {
        const inspected = await dockerCommand(['inspect', '--format', '{{ index .Config.Labels "agentrix.lab" }}', id]);
        if (inspected.code !== 0 && /No such (?:object|container)/i.test(inspected.stderr)) return;
        if (inspected.code !== 0 || inspected.stdout.trim() !== 'true') throw infrastructure('无效的实验容器。');
      }
      await checkedDocker(['rm', '--force', id]); containers.delete(id); removed.add(id);
    },
  };
  return { fetchCommit, download, aaScores, docker };
}

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
  // aaScores returns { asOf, values: { [API model slug]: score } }; providers map exact model identities to their arms.
  createTools, ...createTools(),
};
