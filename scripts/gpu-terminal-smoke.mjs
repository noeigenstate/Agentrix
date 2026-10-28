// The GPU terminal renderer, as a user meets it with the default settings: the terminal draws on a canvas,
// typed commands run, text can be selected and copied without the card expanding, and switching to the
// compatible renderer and back keeps the session. Uses its own profile; never touches a real workspace.
import { testRun } from './test-output.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { _electron as electron } from 'playwright-core';
import { waitFor, terminalsSettled } from './wait.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await testRun('gpu-terminal'), dataDir = path.join(output, 'profile');
const project = { id: randomUUID(), name: 'GPU terminal', path: path.join(output, 'project'), kind: 'local', restore: { terminal: false, codex: false } };
await fs.mkdir(project.path, { recursive: true }); await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 2, projects: [project], settings: { language: 'zh', notifications: false, sound: false, announce: false, closeToTray: false, restoreSessions: false, guideVersion: '9.9.9' } }));
const env = { ...process.env, AGENTRIX_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: path.join(output, 'claude-home') }; delete env.ELECTRON_RUN_AS_NODE; delete env.AGENTRIX_DEV_URL;
const packaged = process.argv.includes('--packaged');
const application = await electron.launch({ executablePath: packaged ? path.join(root, 'release/win-unpacked/Agentrix.exe') : require('electron'), args: packaged ? [] : [root], cwd: root, env, timeout: 30000 });
const errors = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForSelector('.project-panel');
  // A machine without WebGL (some build servers) draws terminals with the DOM renderer by design.
  if (!await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))) { console.log('SKIP: WebGL 2 is not available here; terminals use the compatible renderer.'); process.exitCode = 0; }
  else {
  await page.getByRole('button', { name: '只打开终端', exact: true }).click();
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects[0];
  await waitFor(async () => (await state()).shellReady, 'shell ready');
  // Ordinary shell prompts clear agent state; this fixture keeps its agent visible while commands run.
  await page.evaluate(id => window.agentrix.writeTerminal(id, "function global:prompt { 'AGENT_FIXTURE> ' }; Send-AgentrixEvent 'codex-started' -Agent 'claude'\r"), project.id);
  await waitFor(async () => (await state()).codexActive, 'GPU fixture agent active');
  await page.getByRole('button', { name: '切换到终端', exact: true }).click();
  await page.getByRole('button', { name: '返回总览', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.focus-mode') && !document.querySelector('[data-focus-motion]'));
  await terminalsSettled(page);
  const host = page.locator('.terminal-split[data-codex-active="true"]:visible .terminal-host');
  await host.waitFor();
  assert.equal(await page.locator('.focus-mode').count(), 0, 'GPU interaction starts on a small agent card');
  const screen = () => page.evaluate(id => window.agentrix.attachTerminal(id).then(result => result.value.data), project.id);

  // Drawn on the GPU: a WebGL canvas and no rows of HTML.
  await waitFor(async () => (await host.locator('.xterm-screen canvas').count()) > 0, 'terminal draws on a canvas');
  assert.equal(await host.locator('.xterm-rows > div').count(), 0, 'no HTML rows with the GPU renderer');

  // Typing in the small card runs the command and does not expand the project.
  await host.click({ position: { x: 120, y: 60 } });
  await page.keyboard.type('Write-Output ("GPU" + "_TERMINAL_OK")');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await screen()).includes('GPU_TERMINAL_OK\r\n'), 'typed command ran');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'typing in a terminal never expands the project');

  // The canvas shows the text: bright pixels where the output is.
  const countPixels = async (bright) => {
    const shot = (await host.screenshot()).toString('base64');
    return page.evaluate(async ({ data, bright }) => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
      for (let index = 0; index < pixels.length; index += 4) { const sum = pixels[index] + pixels[index + 1] + pixels[index + 2]; if (bright ? sum > 600 : sum < 24) count++; }
      return count;
    }, { data: shot, bright });
  };
  assert.ok(await countPixels(true) > 400, 'terminal text is drawn');

  // Dim text that clears to the end of its line, as Codex draws its notes, stays on the glass: no black bar
  // behind it (the GPU renderer used to paint the default background there at full opacity).
  const darkBefore = await countPixels(false);
  await page.keyboard.type('1..3 | % { Write-Host "$([char]27)[2mDIM_ROW_$_$([char]27)[K$([char]27)[3m italic$([char]27)[K$([char]27)[0m" }');
  await page.keyboard.press('Enter');
  await waitFor(async () => (await screen()).includes('DIM_ROW_3'), 'dim lines printed');
  await new Promise(resolve => setTimeout(resolve, 300));
  const darkAfter = await countPixels(false);
  await host.screenshot({ path: path.join(output, 'dim-text.png') });
  assert.ok(darkAfter - darkBefore < 500, `dim and italic text leave the background clear (near-black pixels ${darkBefore} -> ${darkAfter})`);

  // Selecting by dragging and copying with Ctrl+C, inside the small card.
  const box = await host.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 4); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 30, box.y + box.height - 10, { steps: 8 }); await page.mouse.up();
  await waitFor(async () => (await host.getAttribute('data-has-selection')) === 'true', 'text selected');
  await page.keyboard.press('Control+c');
  await waitFor(async () => (await page.evaluate(() => window.agentrix.readClipboard())).value.includes('GPU_TERMINAL_OK'), 'selection copied');
  assert.equal(await page.locator('.focus-mode').count(), 0, 'selecting and copying never expands the project');

  // Switching renderers keeps the session and its text.
  await page.evaluate(() => window.agentrix.settings({ terminalRenderer: 'dom' }));
  await waitFor(async () => (await host.locator('.xterm-rows').innerText()).includes('GPU_TERMINAL_OK'), 'compatible renderer shows the same text');
  assert.equal(await host.locator('.xterm-screen canvas').count(), 0);
  await page.evaluate(() => window.agentrix.settings({ terminalRenderer: 'gpu' }));
  await waitFor(async () => (await host.locator('.xterm-screen canvas').count()) > 0 && (await host.locator('.xterm-rows > div').count()) === 0, 'back on the GPU');
  await page.keyboard.press('Escape');
  await host.click({ position: { x: 120, y: 60 } });
  await page.keyboard.type('Write-Output ("STILL" + "_LIVE")'); await page.keyboard.press('Enter');
  await waitFor(async () => (await screen()).includes('STILL_LIVE\r\n'), 'the session kept running through the switches');
  assert.equal((await state()).codexActive, true, 'ordinary commands keep the fixture agent visible');
  assert.ok(await countPixels(true) > 400, 'text is drawn again on the GPU');
  assert.deepEqual(errors, []);
  console.log('PASS: GPU terminal renderer draws, types, selects and copies, and switches renderers without losing the session');
  }
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
