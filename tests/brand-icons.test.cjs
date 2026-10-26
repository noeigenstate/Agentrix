const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { CodexLogo, ClaudeLogo } = require('../src/features/agents/AgentBrandIcon.ts');
const marks = require('../assets/brands/official-marks.json');

const root = path.join(__dirname, '..');
const asset = name => fs.readFileSync(path.join(root, 'assets/brands', name));
const geometry = svg => ({
  viewBox: svg.match(/viewBox="([^"]+)"/)[1],
  path: svg.match(/<path d="([^"]+)"/)[1],
});

test('bundled vectors retain the authenticated source geometry and attribution', () => {
  const fixtures = [
    ['openai-blossom-black.svg', marks.openai, marks.openai.blackSha256],
    ['openai-blossom-white.svg', marks.openai, marks.openai.whiteSha256],
    ['claude-spark.svg', marks.claude, marks.claude.svgSha256],
  ];
  for (const [name, mark, expectedHash] of fixtures) {
    const svg = asset(name);
    assert.equal(crypto.createHash('sha256').update(svg).digest('hex'), expectedHash, name);
    assert.deepEqual(geometry(svg.toString()), { viewBox: mark.viewBox, path: mark.path }, name);
    assert.ok(mark.source.startsWith('https://'));
    assert.match(mark.attribution, /trademarks/);
    assert.doesNotMatch(svg.toString(), /<(?:image|script|foreignObject)|(?:href|src)=/);
  }
  assert.equal(marks.openai.source, 'https://cdn.openai.com/brand/openai-logos.zip');
  assert.equal(marks.claude.source, 'https://claude.com/');
});

test('16px marks preserve aspect ratio, original paths and clear-space canvases', () => {
  for (const [Logo, mark] of [[CodexLogo, marks.openai], [ClaudeLogo, marks.claude]]) {
    for (const size of [16, 24]) {
      const html = renderToStaticMarkup(React.createElement(Logo, { size }));
      assert.match(html, new RegExp(`width="${size}" height="${size}"`));
      assert.match(html, /preserveAspectRatio="xMidYMid meet"/);
      assert.match(html, /aria-hidden="true" focusable="false"/);
      assert.deepEqual(geometry(html), { viewBox: mark.viewBox, path: mark.path });
      assert.doesNotMatch(html, /<(?:line|g|image)|transform=|https?:\/\//);
      assert.equal((html.match(/<path /g) || []).length, 1);
    }
  }
  assert.equal(marks.openai.viewBox, '0 0 716 716');
  assert.equal(marks.claude.viewBox, '0 0 125 125');
});

test('Claude uses the official orange and Codex keeps its original white in mono', () => {
  assert.match(renderToStaticMarkup(React.createElement(ClaudeLogo)), /fill="#D97757"/);
  const codex = renderToStaticMarkup(React.createElement(CodexLogo));
  assert.match(codex, /color="#ffffff"/);
  assert.match(codex, /fill="currentColor"/);
});

test('Codex follows the selected theme while keeping its official geometry', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  globalThis.document = { documentElement: { dataset: {} } };
  for (const [theme, ink] of [['light', '#202124'], ['mono', '#ffffff']]) {
    document.documentElement.dataset.theme = theme;
    const html = renderToStaticMarkup(React.createElement(CodexLogo));
    assert.match(html, new RegExp(`color="${ink}"`));
    assert.match(html, /fill="currentColor"/);
    assert.deepEqual(geometry(html), { viewBox: marks.openai.viewBox, path: marks.openai.path });
  }
  delete document.documentElement;
  assert.match(renderToStaticMarkup(React.createElement(CodexLogo)), /color="#ffffff"/);
});

test('ClaudeSpark retains its export and size API as a direct official-logo alias', () => {
  const filename = path.join(root, 'src/features/reading/Timeline.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  assert.equal(mod.exports.ClaudeSpark, ClaudeLogo);
  assert.equal(
    renderToStaticMarkup(React.createElement(mod.exports.ClaudeSpark, { size: 20 })),
    renderToStaticMarkup(React.createElement(ClaudeLogo, { size: 20 })),
  );
});

test('Codex inherits its own ink, and a running node is a heavier ring with no animation', () => {
  const css = fs.readFileSync(path.join(root, 'src/features/reading/reading-flow.css'), 'utf8');
  const fillRules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector, body]) => selector.includes('.agent-brand-codex') && /\bfill\s*:/.test(body))
    .map(([, selector, body]) => ({ selector: selector.trim(), fill: body.match(/\bfill\s*:\s*([^;]+)/)[1].trim() }));
  assert.deepEqual(fillRules, []);
  assert.match(renderToStaticMarkup(React.createElement(CodexLogo)), /fill="currentColor"/);
  assert.match(css, /\.reading-node > \.agent-brand-codex \{ width: var\(--step-node\); height: var\(--step-node\); \}/);
  assert.doesNotMatch(css, /reading-spark|spark-bloom|agent-brand-[^{]+\{[^}]*\b(?:animation|transform):/);
  assert.match(css, /\.reading-step\.is-running \.reading-node \{ box-shadow: inset 0 0 0 2px var\(--node-tint\); \}/);
  assert.doesNotMatch(css, /@keyframes|animation:/);
});
