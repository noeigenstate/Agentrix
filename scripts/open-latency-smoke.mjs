// Native, offline acceptance: node scripts/open-latency-smoke.mjs [--sizes 24,48,96] [--agents codex,claude].
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { _electron as electron } from 'playwright-core';
import { createFixture, isolatedEnvironment } from './open-latency-fixtures.mjs';
import { withGuiLock } from './gui-lock.mjs';
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('This probe uses the Windows offline CLI fixture.');
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const sizes = option('--sizes', '24,48,96').split(',').map(Number), agents = option('--agents', 'codex,claude').split(',');
assert.ok(sizes.every(n => Number.isInteger(n) && n > 0) && agents.every(a => ['codex', 'claude'].includes(a)));
const scratch = path.join(root, '.probe'); await fs.mkdir(scratch, { recursive: true });
const output = await fs.mkdtemp(path.join(scratch, 'open-latency-')), dist = path.join(output, 'dist');
await build({ root, configFile: false, base: './', plugins: [react()], build: { target: 'es2022', outDir: dist, emptyOutDir: true, chunkSizeWarningLimit: 2000 }, logLevel: 'error' });
const results = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const result = await fn(); if (result) return result; await sleep(20); }
  throw new Error(`Timed out: ${label}`);
}

function observe(marker) {
  const now = () => performance.timeOrigin + performance.now(), events = [], watches = new Map();
  let next = 'cold';
  const begin = (label, focus) => watches.set(label, { label, focus, at: now() });
  window.__openLatency = { events, arm(label) { next = label; } };
  begin('startup', false);
  document.addEventListener('click', event => {
    if (!event.target.closest('.panel-header')) return;
    events.push({ label: next, name: 'click', t: now() }); begin(next, true);
  }, true);
  const frame = () => {
    const panel = document.querySelector('[data-project-id]'), view = panel?.querySelector('.reading-view');
    if (view?.textContent.includes(marker)) {
      const scroll = view.querySelector('.reading-scroll'), body = view.querySelector('.reading-content'), input = view.querySelector('textarea');
      const paragraph = [...view.querySelectorAll('p')].findLast(node => node.textContent.includes(marker));
      const bounds = scroll?.getBoundingClientRect(), rect = paragraph?.getBoundingClientRect();
      const visible = bounds && rect && rect.bottom > bounds.top && rect.top < bounds.bottom && getComputedStyle(body).visibility !== 'hidden';
      for (const watch of watches.values()) {
        if (!watch.content && visible && (!watch.focus || panel.classList.contains('is-focused')) && !document.querySelector('[data-focus-motion]')) {
          watch.content = true; events.push({ label: watch.label, name: 'readable', t: now(), readOnly: !!input?.disabled });
        }
        if (!watch.input && input && !input.disabled) { watch.input = true; events.push({ label: watch.label, name: 'composer', t: now() }); }
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function checkPaging(page, directory) {
  const scroll = page.locator('.reading-scroll');
  // A wheel event establishes reader intent; the scroll itself reaches the sentinel in one frame.
  const before = await scroll.evaluate(node => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    node.scrollTo({ top: 0, behavior: 'instant' });
    const top = node.getBoundingClientRect().top;
    const entries = [...node.querySelectorAll('[data-reading-entry]')];
    const anchor = entries.find(entry => entry.getBoundingClientRect().bottom > top);
    const before = { count: entries.length, anchor: anchor.dataset.readingEntry, y: anchor.getBoundingClientRect().top };
    return before;
  });
  await wait(() => scroll.locator('[data-reading-entry]').count().then(count => count > before.count), 'scroll-up history page');
  const position = () => scroll.evaluate((node, before) => {
    const entries = [...node.querySelectorAll('[data-reading-entry]')];
    const anchor = entries.find(entry => entry.dataset.readingEntry === before.anchor);
    return { count: entries.length, height: node.scrollHeight, unique: new Set(entries.map(entry => entry.dataset.readingEntry)).size,
      anchorDelta: anchor.getBoundingClientRect().top - before.y };
  }, before);
  let lastHeight, stable = 0;
  // Worker parses change many older replies on successive frames. Check after layout settles, not mid-commit.
  const after = await wait(async () => {
    const value = await position();
    stable = value.height === lastHeight && Math.abs(value.anchorDelta) <= 2 ? stable + 1 : 0;
    lastHeight = value.height;
    return stable >= 3 ? value : null;
  }, 'Markdown layout and prepend anchor', 5000);
  assert.equal(after.count, after.unique, 'history prepend has no duplicate DOM entries');
  assert.ok(Math.abs(after.anchorDelta) <= 2, `scroll anchor moved ${after.anchorDelta}px`);
  assert.equal(await scroll.locator('.reading-unseen').count(), 0, 'older pages are not new messages');
  // The same operation remains available through the existing earlier button, including keyboard activation.
  await scroll.locator('.reading-earlier').evaluate(button => button.click());
  await wait(() => scroll.locator('[data-reading-entry]').count().then(count => count > after.count), 'earlier button history page');
  await page.screenshot({ path: path.join(directory, 'paging.png') });
  return { before: before.count, afterScroll: after.count, afterButton: await scroll.locator('[data-reading-entry]').count(), anchorDelta: after.anchorDelta };
}

await withGuiLock(`open-latency ${process.pid}`, async () => {
for (const mib of sizes) {
  const fixtureDir = path.join(output, `size-${mib}`), fixture = await createFixture(root, fixtureDir, mib);
  for (const agent of agents) for (const mode of ['cold', 'startup']) {
    const directory = path.join(fixtureDir, `${agent}-${mode}`), profile = path.join(directory, 'profile'), home = path.join(directory, 'home');
    const transcript = fixture.transcripts[agent];
    for (const folder of [profile, home, path.join(home, 'AppData/Roaming'), path.join(home, 'AppData/Local')]) await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(profile, 'workspace.json'), JSON.stringify({ version: 2, projects: [{ ...fixture.project,
      restore: { terminal: true, codex: true, agent, cwd: fixture.project.path, threadId: transcript.threadId, interrupted: false } }],
      settings: { language: 'en', startView: 'workspace', theme: 'mono', surface: 'solid', terminalRenderer: 'dom', restoreSessions: true, closeToTray: false, notifications: false, sound: false, focusAnimation: 'smooth' } }));
    const boot = path.join(directory, 'boot.cjs');
    await fs.writeFile(boot, `const fs=require('node:fs'),fsp=require('node:fs/promises'),Module=require('node:module'),path=require('node:path');
const {app,dialog}=require('electron');const root=${JSON.stringify(root)},dist=${JSON.stringify(dist)};
globalThis.openLatency={events:[],forbidden:0};const clock=()=>performance.timeOrigin+performance.now();
const forbidden=${JSON.stringify([path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude'), path.join(os.homedir(), 'AppData/Roaming/Agentrix')].map(p => p.toLowerCase()))};
function guard(file){if(typeof file!=='string')return;const p=path.resolve(file).toLowerCase();if(forbidden.some(r=>p===r||p.startsWith(r+path.sep))){globalThis.openLatency.forbidden++;throw Error('Real account path blocked');}}
for(const key of ['open','readFile','stat','readdir','access']){const fn=fsp[key].bind(fsp);fsp[key]=(file,...args)=>{guard(file);return fn(file,...args);};}
for(const key of ['readFileSync','statSync','existsSync','readdirSync']){const fn=fs[key].bind(fs);fs[key]=(file,...args)=>{guard(file);return fn(file,...args);};}
app.getAppPath=()=>root;app.getVersion=()=>${JSON.stringify(require('../package.json').version)};
dialog.showErrorBox=(title,message)=>{fs.writeFileSync(${JSON.stringify(path.join(directory, 'error.log'))},title+'\\n'+message);app.exit(1);};
app.on('browser-window-created',(_,w)=>{w.on('show',()=>globalThis.openLatency.events.push({name:'show',t:clock()}));w.webContents.once('dom-ready',()=>w.webContents.executeJavaScript('('+${JSON.stringify(observe.toString())}+')('+${JSON.stringify(JSON.stringify(transcript.marker))}+')'));});
const load=Module._extensions['.js'];Module._extensions['.cjs']=(module,filename)=>{if(filename===path.join(root,'electron/app/protocols.cjs')){module._compile(fs.readFileSync(filename,'utf8').replace("path.resolve(root, 'dist')",'dist').replace("const directory = dist;",'const directory = '+JSON.stringify(dist)+';'),filename);}else load(module,filename);};
require(path.join(root,'electron/main.cjs'));`);
    let app, page, owned;
    try {
      app = await electron.launch({ executablePath: require('electron'), args: [boot, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], cwd: root,
        env: isolatedEnvironment(fixture, profile, home), timeout: 45000 });
      owned = app.process(); page = await app.firstWindow();
      page.on('pageerror', error => console.error(error));
      await page.waitForFunction(() => !!window.__openLatency);
      await page.locator('.panel-header').first().waitFor();
      const seen = label => page.evaluate(label => window.__openLatency.events.find(e => e.label === label && e.name === 'readable'), label);
      if (mode === 'cold') await page.locator('.panel-header').first().click({ force: true });
      await wait(() => seen(mode), mode);
      await page.screenshot({ path: path.join(directory, 'readable.png') });
      await wait(() => page.locator('.reading-composer textarea').isEnabled(), 'composer ready');
      await page.locator('.reading-composer textarea').fill('offline probe'); await page.locator('.reading-composer textarea').fill('');
      if (mode === 'startup') { await page.evaluate(() => window.__openLatency.arm('first-open')); await page.locator('.panel-header').first().click({ force: true }); await wait(() => seen('first-open'), 'first open'); }
      for (let n = 1; n <= 2; n++) {
        await page.locator('.focus-sidebar').getByRole('button', { name: /overview/i }).first().click();
        await page.waitForFunction(() => !document.querySelector('[data-focus-motion]'));
        const label = `warm-${n}`; await page.evaluate(label => window.__openLatency.arm(label), label);
        await page.locator('.panel-header').first().click({ force: true }); await wait(() => seen(label), label);
      }
      const paging = await checkPaging(page, directory);
      const main = await app.evaluate(() => globalThis.openLatency), events = await page.evaluate(() => window.__openLatency.events);
      assert.equal(main.forbidden, 0, 'no real account path attempted');
      const show = main.events.find(e => e.name === 'show').t;
      const measured = events.filter(e => e.name === 'readable').map(e => {
        const start = e.label === 'startup' ? show : events.find(c => c.name === 'click' && c.label === e.label).t;
        const composer = events.find(event => event.label === e.label && event.name === 'composer');
        return { label: e.label, ms: e.t - start, composerMs: composer ? composer.t - start : null, readOnly: e.readOnly };
      });
      const cli = JSON.parse(await fs.readFile(path.join(fixture.project.path, 'cli-latency.json'), 'utf8'));
      const result = { agent, mib, mode, transcriptBytes: transcript.bytes, measured, cli, paging, events, main, directory };
      results.push(result); await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
      await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
      for (const value of measured) assert.ok(value.ms <= 3000, `${agent} ${mib} MiB ${value.label}: ${value.ms.toFixed(1)} ms > 3000`);
      console.log(JSON.stringify({ agent, mib, mode, measured }));
    } catch (error) { if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); throw error; }
    finally {
      if (app) await app.evaluate(({ app }) => app.quit()).catch(() => {});
      if (owned?.exitCode === null) await Promise.race([new Promise(resolve => owned.once('exit', resolve)), sleep(5000)]);
      assert.ok(!owned || owned.exitCode !== null, 'previous isolated GUI exited before another can start');
    }
  }
}
});
console.log(`PASS: native open latency <= 3 seconds; artifacts: ${output}`);
