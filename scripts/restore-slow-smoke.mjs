// Restore mixed agent sessions while the window answers PowerShell's cursor-position query late.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { waitFor } from './wait.mjs';

if (process.platform !== 'win32') {
  console.log('SKIP: slow session restoration smoke requires Windows PowerShell.');
  process.exit(0);
}

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('restore-slow');
const bin = path.join(output, 'bin');
const packaged = process.argv.includes('--packaged');
await fs.mkdir(bin, { recursive: true });
await exec(path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'claude.exe')}`, path.join(root, 'tests/fixtures/restore-codex.cs')], { windowsHide: true });
await fs.copyFile(path.join(bin, 'claude.exe'), path.join(bin, 'codex.exe'));

async function receipt(project) {
  try { return JSON.parse(await fs.readFile(path.join(project.path, 'resume-receipt.json'), 'utf8')); }
  catch { return null; }
}

async function reportMissing(page, projects, label) {
  for (const project of projects) {
    if (await receipt(project)) continue;
    let text = '';
    if (page) {
      text = await page.evaluate(async id => {
        if (typeof window.agentrix?.attachTerminal !== 'function') return '';
        const result = await window.agentrix.attachTerminal(id);
        return result.ok && typeof result.value?.data === 'string' ? result.value.data.slice(-400) : '';
      }, project.id).catch(() => '');
    }
    console.error(`MISSING (${label}): ${project.name}${text ? `\n${text}` : ''}`);
  }
}

async function runScenario(label, delay) {
  const scenarioDir = path.join(output, label);
  const dataDir = path.join(scenarioDir, 'user-data');
  const codexHome = path.join(scenarioDir, 'codex-home');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  const projects = [];
  for (const [agent, count] of [['claude', 6], ['codex', 2]]) {
    for (let index = 0; index < count; index++) {
      const name = `${agent}-${index + 1}`;
      const directory = path.join(scenarioDir, name);
      await fs.mkdir(directory);
      const sessionId = randomUUID();
      projects.push({
        id: randomUUID(), name, path: directory, kind: 'local', seenEvents: [], sessionId,
        restore: { terminal: true, codex: true, cwd: directory, agent, threadId: sessionId, interrupted: true },
      });
      if (agent === 'codex') {
        await fs.writeFile(path.join(codexHome, 'sessions', `rollout-${sessionId}.jsonl`), [
          { type: 'session_meta', payload: { id: sessionId, cwd: directory, source: 'cli' } },
          { type: 'event_msg', payload: { type: 'task_started' } },
        ].map(value => JSON.stringify(value)).join('\n') + '\n');
      }
    }
  }
  await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({
    version: 2, projects,
    settings: { terminalRenderer: 'dom', autoSave: false, notifications: false, sound: false, closeToTray: false, restoreSessions: true },
  }));
  const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, AGENTRIX_TEST_RESTORE: '1', CODEX_HOME: codexHome };
  const originalPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = bin + path.delimiter + originalPath;
  delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;

  let application; let page;
  try {
    application = await electron.launch({
      executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'),
      args: [...(packaged ? [] : [root]), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
      cwd: root, env, timeout: 30000,
    });
    page = await application.firstWindow();
    // A window busy starting many terminals: for the first seconds its cursor-position answers reach the shell
    // late (ConPTY waits about 500 ms for one). Only startup is slow; a window answering late forever would make
    // every keystroke wait out that timeout.
    if (delay) await application.evaluate(({ ipcMain }, delay) => {
      const listeners = ipcMain.listeners('terminal:write'), until = Date.now() + 4000;
      ipcMain.removeAllListeners('terminal:write');
      const answer = new RegExp(String.fromCharCode(27) + '\\[\\d+;\\d+R');
      ipcMain.on('terminal:write', (event, id, data) => {
        const go = () => listeners.forEach(listener => listener(event, id, data));
        if (answer.test(data) && Date.now() < until) setTimeout(go, delay); else go();
      });
    }, delay);
    await waitFor(async () => (await Promise.all(projects.map(receipt))).every(Boolean), `${label}: all eight restored commands ran`, 40000);
    for (const project of projects) {
      const result = await receipt(project);
      assert.ok(result, `${label}: ${project.name} has a resume receipt`);
      if (project.restore.agent === 'claude') {
        assert.equal(result.args[0], '--settings', `${label}: ${project.name} uses the Claude wrapper`);
        // The hooks travel as a settings file (Windows PowerShell does not escape JSON for claude.cmd); the wrapper deletes it
        // when Claude exits, so only its name is left to check here.
        assert.match(result.args[1], /[\\/]claude-settings-[0-9a-f]{32}\.json$/, `${label}: ${project.name} receives a settings file`);
        // Then what the reading view can show (electron/features/agents/reading-note.cjs), before the resume arguments.
        assert.deepEqual([result.args[2], /^You run inside Agentrix/.test(result.args[3])], ['--append-system-prompt', true], `${label}: ${project.name} is told what the reading view shows`);
        assert.deepEqual(result.args.slice(4), ['--resume', project.sessionId, '继续'], `${label}: ${project.name} resumes intact`);
      } else {
        assert.deepEqual(result.args.slice(-3), ['resume', project.sessionId, '继续'], `${label}: ${project.name} resumes intact`);
      }
    }
    console.log(`PASS: ${label}: six Claude Code and two Codex sessions restored with intact arguments (cursor answers +${delay} ms)`);
  } catch (error) {
    await reportMissing(page, projects, label);
    throw error;
  } finally {
    if (application) {
      // The process handle is taken before exit: Playwright cannot look it up once the app is gone.
      const child = application.process();
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, `${label}: application exits before the next launch`, 10000);
    }
  }
}

console.log(`Session restoration output: ${output}`);
await runScenario('delayed', 700);
await runScenario('immediate', 0);
