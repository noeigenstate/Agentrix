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
const codexViewBox = '180.499 180.499 354.675 354.675';

const root = path.join(__dirname, '..');
const asset = name => fs.readFileSync(path.join(root, 'assets/brands', name));
const geometry = svg => ({
  viewBox: svg.match(/viewBox="([^"]+)"/)[1],
  path: svg.match(/<path d="([^"]+)"/)[1],
});

function loadTimeline() {
  const filename = path.join(root, 'src/features/reading/Timeline.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  return mod.exports;
}

test('bundled vectors retain the authenticated source geometry and attribution', () => {
  const fixtures = [
    ['openai-blossom-black.svg', marks.openai, marks.openai.blackSha256],
    ['openai-blossom-white.svg', marks.openai, marks.openai.whiteSha256],
    ['claude-spark.svg', marks.claude, marks.claude.svgSha256],
  ];
  for (const [name, mark, expectedHash] of fixtures) {
    const svg = asset(name);
    assert.equal(crypto.createHash('sha256').update(svg).digest('hex'), expectedHash, name);
    const viewBox = mark === marks.openai ? '0 0 716 716' : mark.viewBox;
    assert.deepEqual(geometry(svg.toString()), { viewBox, path: mark.path }, name);
    assert.ok(mark.source.startsWith('https://'));
    assert.match(mark.attribution, /trademarks/);
    assert.doesNotMatch(svg.toString(), /<(?:image|script|foreignObject)|(?:href|src)=/);
  }
  assert.equal(marks.openai.source, 'https://cdn.openai.com/brand/openai-logos.zip');
  assert.equal(marks.claude.source, 'https://claude.com/');
});

test('marks preserve aspect ratio and original paths in balanced square viewBoxes', () => {
  for (const [Logo, mark, viewBox] of [[CodexLogo, marks.openai, codexViewBox], [ClaudeLogo, marks.claude, marks.claude.viewBox]]) {
    for (const size of [16, 22, 24, 26]) {
      const html = renderToStaticMarkup(React.createElement(Logo, { size }));
      assert.match(html, new RegExp(`width="${size}" height="${size}"`));
      assert.match(html, /preserveAspectRatio="xMidYMid meet"/);
      assert.match(html, /aria-hidden="true" focusable="false"/);
      assert.deepEqual(geometry(html), { viewBox, path: mark.path });
      assert.doesNotMatch(html, /<(?:line|g|image)|transform=|https?:\/\//);
      assert.equal((html.match(/<path /g) || []).length, 1);
    }
  }
  assert.equal(marks.openai.viewBox, codexViewBox);
  assert.match(marks.openai.sourceNotes, /original SVG viewBox is 0 0 716 716/);
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
  for (const [theme, ink] of [['light', '#24272d'], ['mono', '#ffffff']]) {
    document.documentElement.dataset.theme = theme;
    const html = renderToStaticMarkup(React.createElement(CodexLogo));
    assert.match(html, new RegExp(`color="${ink}"`));
    assert.match(html, /fill="currentColor"/);
    assert.deepEqual(geometry(html), { viewBox: codexViewBox, path: marks.openai.path });
  }
  delete document.documentElement;
  assert.match(renderToStaticMarkup(React.createElement(CodexLogo)), /color="#ffffff"/);
});

test('ClaudeSpark retains its export and size API as a direct official-logo alias', () => {
  const { ClaudeSpark } = loadTimeline();
  assert.equal(ClaudeSpark, ClaudeLogo);
  assert.equal(
    renderToStaticMarkup(React.createElement(ClaudeSpark, { size: 20 })),
    renderToStaticMarkup(React.createElement(ClaudeLogo, { size: 20 })),
  );
});

test('Claude keeps its official spark without a ring in failed, running and earlier turns', () => {
  const { TimelineStep, AgentMark } = loadTimeline();
  for (const state of [null, 'running', 'failed']) for (const latest of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(TimelineStep, {
      at: 1, kind: 'agent', agent: 'claude', state, latest, who: 'Claude Code',
      mark: React.createElement(AgentMark, { agent: 'claude' }), children: null,
    }));
    assert.deepEqual(geometry(html), { viewBox: marks.claude.viewBox, path: marks.claude.path });
    assert.equal((html.match(/<path /g) || []).length, 1);
    assert.doesNotMatch(html, /<(?:circle|line|animate|image)\b/);
  }
  const css = fs.readFileSync(path.join(root, 'src/features/reading/reading-flow.css'), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of rules) {
    if (!selector.includes('.reading-node') || !/\b(?:box-shadow|outline|border(?:-(?:width|style|color))?)\s*:/.test(body)) continue;
    for (const agent of ['claude', 'codex']) assert.match(selector, new RegExp(`:not\\([^)]*\\.is-${agent}\\b[^)]*\\)`), selector);
  }
});

test('Codex inherits its own ink, and a running node is a heavier ring with no animation', () => {
  const css = fs.readFileSync(path.join(root, 'src/features/reading/reading-flow.css'), 'utf8');
  const fillRules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector, body]) => selector.includes('.agent-brand-codex') && /\bfill\s*:/.test(body))
    .map(([, selector, body]) => ({ selector: selector.trim(), fill: body.match(/\bfill\s*:\s*([^;]+)/)[1].trim() }));
  assert.deepEqual(fillRules, []);
  assert.match(renderToStaticMarkup(React.createElement(CodexLogo)), /fill="currentColor"/);
  // Both official marks use the same box in the reading node.
  assert.match(css, /\.reading-node > :is\(\.agent-brand-codex, \.agent-brand-claude\) \{ width: 26px; height: 26px; \}/);
  assert.match(css, /\.reading-node > \.user-avatar \{ width: 100%; height: 100%; \}/);
  assert.doesNotMatch(css, /reading-spark|spark-bloom|agent-brand-[^{]+\{[^}]*\b(?:animation|transform):/);
  // Only generic nodes have rings, including while running or failed; brand marks stay borderless.
  assert.match(css, /\.reading-step:not\(\.is-user, \.is-claude, \.is-codex\) \.reading-node \{ box-shadow: inset 0 0 0 1\.5px var\(--node-tint\); \}/);
  assert.match(css, /\.reading-step\.is-running:not\(\.is-user, \.is-claude, \.is-codex\) \.reading-node \{ box-shadow: inset 0 0 0 2px var\(--node-tint\); \}/);
  assert.match(css, /\.reading-step\.is-failed:not\(\.is-user, \.is-claude, \.is-codex\) \.reading-node \{ --node-tint: var\(--flow-fail\); box-shadow: inset 0 0 0 2px var\(--node-tint\); \}/);
  assert.doesNotMatch(/\.reading-node \{[^}]*\}/.exec(css)[0], /box-shadow/, 'the base node has no ring');
  assert.doesNotMatch(css, /@keyframes|animation:/);
});
