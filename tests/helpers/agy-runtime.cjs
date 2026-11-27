const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { createAgyRuntime } = require('../../electron/features/agy-acp/index.cjs');

const exec = promisify(execFile);

async function processTree(pid) {
  const args = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']]
    : ['ps', ['-axo', 'pid=,ppid=']];
  const { stdout } = await exec(...args, { windowsHide: true });
  const rows = stdout.trim().split(/\r?\n/).map(row => row.trim().split(/\s+/).map(Number)), tree = new Set([pid]);
  for (const parent of tree) for (const [child, owner] of rows) if (owner === parent) tree.add(child);
  return tree;
}

async function temporary(t) {
  const root = path.resolve(__dirname, '../../.test-output');
  await fs.promises.mkdir(root, { recursive: true });
  const directory = fs.realpathSync.native(await fs.promises.mkdtemp(path.join(root, 'agy-acp-')));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

function recordEvents() {
  const all = [], waiting = new Set();
  return {
    all,
    emit(event) {
      all.push(event);
      for (const waiter of waiting) {
        if (!waiter.matches(event)) continue;
        waiting.delete(waiter);
        waiter.resolve(event);
      }
    },
    wait(matches) {
      return new Promise(resolve => waiting.add({ matches, resolve }));
    },
  };
}

function session(dataDir, spec = {}, options = {}) {
  const events = recordEvents(), runtimeSessionId = randomUUID();
  const factory = createAgyRuntime({ dataDir, ...options });
  const runtime = factory.create({ cwd: dataDir, runtimeSessionId, projectId: 'project', terminalId: 'terminal', ...spec }, events.emit);
  return { factory, runtime, events };
}

function fakeProcess(trace, scenario) {
  const server = path.resolve(__dirname, '../fixtures/agy-acp/server.cjs');
  return (file, args, options) => spawn(process.execPath, [server, trace, scenario, ...args], options);
}

async function projectExtensions(cwd, evidence = cwd) {
  const directory = path.join(cwd, '.agents');
  await fs.promises.mkdir(directory);
  const script = path.join(directory, 'fixture.cjs');
  const hook = path.join(evidence, 'hook-ran'), mcp = path.join(evidence, 'mcp-ran');
  await fs.promises.writeFile(script, `
    const fs = require('node:fs');
    const readline = require('node:readline');
    if (process.argv[2] === 'hook') {
      fs.writeFileSync(process.argv[3], 'SessionStart');
      process.stdout.write('{}');
    } else {
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        if (id == null) return;
        if (method === 'tools/list') fs.writeFileSync(process.argv[3], method);
        const result = method === 'initialize'
          ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : { tools: [] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      });
    }
  `);
  const command = [process.execPath, script, 'hook', hook].map(arg => '"' + arg + '"').join(' ');
  await fs.promises.writeFile(path.join(directory, 'hooks.json'), JSON.stringify({ fixture: { SessionStart: [{ type: 'command', command }] } }));
  await fs.promises.writeFile(path.join(directory, 'mcp_config.json'), JSON.stringify({
    mcpServers: { fixture: { command: process.execPath, args: [script, 'mcp', mcp] } },
  }));
  return { hook, mcp };
}

module.exports = { temporary, recordEvents, session, fakeProcess, projectExtensions, processTree };
