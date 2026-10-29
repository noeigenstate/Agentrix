const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { chromium } = require('playwright-core');

// Use an installed browser with Playwright's temporary profile; Electron and real sessions are never opened.
const browserPath = [
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(filename => filename && fs.existsSync(filename));
const root = path.resolve(__dirname, '..');

test('revealing a hidden cmd terminal keeps the wrapped prompt in the DOM viewport', { skip: !browserPath, timeout: 60000 }, async t => {
  const sources = Object.fromEntries([
    ['react', 'react/cjs/react.production.js'], ['react/jsx-runtime', 'react/cjs/react-jsx-runtime.production.js'],
    ['react-dom', 'react-dom/cjs/react-dom.production.js'], ['react-dom/client', 'react-dom/cjs/react-dom-client.production.js'],
    ['scheduler', 'scheduler/cjs/scheduler.production.js'],
  ].map(([name, filename]) => [name, fs.readFileSync(path.join(root, 'node_modules', filename), 'utf8')]));
  for (const name of ['TerminalPane', 'terminal-fit']) sources[name] = ts.transpileModule(fs.readFileSync(path.join(root, 'src/features/terminal', name + (name === 'TerminalPane' ? '.tsx' : '.ts')), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  t.after(() => browser.close());
  const prefix = 'D:\\a\\Agentrix\\Agentrix\\.test-output\\cmd-1793265759578\\';
  const prompt = prefix + '命令提示符 项目\\sub>';
  // At 55 columns the first wide character cannot fit in the last cell; 54 and 56 cover either side.
  for (const cols of [55, 54, 56]) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    try {
      await page.setContent('<div id="slot"><div id="root" style="width:1000px;height:612px"></div></div>');
      await page.addStyleTag({ path: path.join(root, 'node_modules/@xterm/xterm/css/xterm.css') });
      await page.addStyleTag({ content: '.terminal-host,.xterm { width:100%; height:100%; overflow:hidden; }' });
      await page.addScriptTag({ path: path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
      await page.evaluate(sources => {
        const noop = () => {}, disposable = { dispose: noop }, modules = new Map();
        const fixture = window.fixture = { resizes: [] };
        // A busy CI renderer need not have an idle slot before the visibility callback flushes xterm's resize.
        window.requestIdleCallback = () => 1;
        window.cancelIdleCallback = noop;
        // Intersection notifications can arrive after the activation frame on a busy renderer.
        // Hold that ordering to make the paused-renderer resize race deterministic.
        const Observer = window.IntersectionObserver;
        window.IntersectionObserver = class extends Observer {
          constructor(callback, options) {
            super((entries, observer) => {
              if (fixture.revealing && entries.some(entry => entry.isIntersecting)) requestAnimationFrame(() => callback(entries, observer));
              else callback(entries, observer);
            }, options);
          }
        };
        const stubs = {
          '@xterm/xterm': { Terminal: window.Terminal },
          'terminal-popup': { registerReadingTerminal: () => noop },
          'terminal-screen': { registerScreen: (_id, terminal) => { fixture.terminal = terminal; return noop; }, writeScreen: (_id, data) => fixture.terminal.write(data) },
          'terminal-links': { createTerminalLinkProvider: noop }, 'terminal-styling': { styleTerminal: () => disposable },
          'terminal-theme': { terminalOptions: { fontWeight: 400 }, terminalTheme: () => ({}) },
          'terminal-renderer': { gpuRenderer: () => ({ set: noop, dispose: noop }), setTerminalWeight: noop, terminalRenderer: () => 'dom', useTerminalRenderer: () => 'dom' },
          'terminal-font': { terminalFontFamily: () => 'monospace' }, 'i18n': { t: text => text }, 'platform': { isWindows: true, isMac: false },
        };
        const load = name => {
          if (name.endsWith('.css')) return {};
          const key = name.startsWith('.') ? name.split('/').at(-1) : name;
          if (Object.hasOwn(stubs, key)) return stubs[key];
          if (!modules.has(key)) {
            const module = { exports: {} }; modules.set(key, module);
            new Function('require', 'module', 'exports', sources[key])(load, module, module.exports);
          }
          return modules.get(key).exports;
        };
        window.agentrix = {
          onTerminalData: () => noop, onTerminalPaste: () => noop, terminalFocus: noop,
          resizeTerminal: (_id, cols, rows) => fixture.resizes.push({ cols, rows, paused: fixture.terminal._core._renderService._isPaused }), writeTerminal: noop,
          attachTerminal: async () => ({ ok: true, value: { sessionId: 'session', seq: 0, data: '' } }),
        };
        const React = load('react'), { flushSync } = load('react-dom');
        const app = load('react-dom/client').createRoot(document.getElementById('root'));
        const { TerminalPane } = load('TerminalPane');
        fixture.render = focused => flushSync(() => app.render(React.createElement(TerminalPane, {
          id: 'terminal', sessionId: 'session', fontSize: 12, focused, onError: message => { throw new Error(message); }, onOpenLink: noop,
        })));
        fixture.size = (cols, rows) => {
          const cell = fixture.terminal._core._renderService.dimensions.css.cell;
          document.getElementById('root').style.cssText = `width:${Math.ceil(cols * cell.width + 14)}px;height:${Math.ceil(rows * cell.height)}px`;
        };
        fixture.render(false);
      }, sources);
      await page.waitForFunction(() => window.fixture.terminal?._core._renderService.dimensions.css.cell.width > 0);
      await page.evaluate(() => window.fixture.size(134, 34));
      await page.waitForFunction(() => window.fixture.terminal.cols === 134 && window.fixture.terminal.rows === 34 && !document.querySelector('[data-fit-pending]'));
      await page.evaluate(async prefix => {
        const terminal = window.fixture.terminal;
        await new Promise(resolve => terminal.write(Array.from({ length: 150 }, (_, i) => `scrollback line ${i}\r\n`).join('') + '\r\n' + prefix + '命令提示符 项目>', resolve));
        document.getElementById('slot').style.display = 'none';
      }, prefix);
      await page.waitForFunction(() => window.fixture.terminal._core._renderService._isPaused && !document.querySelector('[data-fit-pending]'));
      await page.evaluate(async ({ prompt, cols }) => {
        const terminal = window.fixture.terminal;
        await new Promise(resolve => terminal.write('cd sub\r\n\r\n' + prompt, resolve));
        window.fixture.size(cols, 33);
        window.fixture.revealing = true;
        document.getElementById('slot').style.display = '';
        window.fixture.render(true);
      }, { prompt, cols });
      await page.waitForFunction(cols => window.fixture.terminal.cols === cols && !document.querySelector('[data-fit-pending]') && !window.fixture.terminal._core._renderService._isPaused, cols);
      const result = await page.evaluate(() => {
        const terminal = window.fixture.terminal, buffer = terminal.buffer.active;
        return { rows: [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent),
          buffer: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)),
          baseY: buffer.baseY, viewportY: buffer.viewportY, resizes: window.fixture.resizes };
      });
      assert.ok(result.buffer.join('').includes(prompt), 'reflow preserves the actual prompt');
      assert.ok(result.rows.join('').includes(prompt), JSON.stringify({ cols, tail: result.rows.slice(-5), baseY: result.baseY, viewportY: result.viewportY, resizes: result.resizes }));
      assert.equal(result.viewportY, result.baseY, 'the viewport follows the bottom through reveal and reflow');
    } finally { await page.close(); }
  }
});
