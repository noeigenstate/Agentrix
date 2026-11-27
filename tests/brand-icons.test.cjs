const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readCss, assertRule } = require('./helpers/css-rules.cjs');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { AntigravityLogo, CodexLogo, ClaudeLogo, brandIconOf } = require('../src/features/agents/AgentBrandIcon.ts');
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

test('Antigravity uses the same official monochrome path in both themes', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  globalThis.document = { documentElement: { dataset: {} } };
  assert.equal(brandIconOf('agy'), AntigravityLogo);
  for (const [theme, ink] of [['light', '#202124'], ['mono', '#ffffff']]) {
    document.documentElement.dataset.theme = theme;
    const html = renderToStaticMarkup(React.createElement(AntigravityLogo));
    const mark = geometry(html);
    assert.equal(mark.viewBox, '0 0 180 180');
    assert.equal(crypto.createHash('sha256').update(mark.path).digest('hex'), 'cbc9e89e57b6ec9d4a155a53e84b722edc8f4ffcf9e33f6765bbd04cbca77422');
    assert.match(html, new RegExp(`fill="${ink}"`));
    assert.doesNotMatch(html, /<(?:image|script|foreignObject)|(?:href|src)=/);
  }
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
  const css = readCss('src/features/reading/reading-flow.css');
  for (const { selector, property } of css.declarations) {
    if (!selector.includes('.reading-node') || !/^(?:box-shadow|outline|border(?:-(?:width|style|color))?)$/.test(property)) continue;
    for (const agent of ['claude', 'codex']) assert.match(selector, new RegExp(`:not\\([^)]*\\.is-${agent}\\b[^)]*\\)`), selector);
  }
});

test('Codex inherits its own ink, and a running node is a heavier ring with no animation', () => {
  const css = readCss('src/features/reading/reading-flow.css');
  assert.deepEqual(css.declarations.filter(({ selector, property }) => selector.includes('.agent-brand-codex') && property === 'fill'), []);
  assert.match(renderToStaticMarkup(React.createElement(CodexLogo)), /fill="currentColor"/);
  // Both official marks use the same box in the reading node.
  assertRule(css, '.reading-node > :is(.agent-brand-codex, .agent-brand-claude)', { width: '26px', height: '26px' });
  assertRule(css, '.reading-node > .user-avatar', { width: '100%', height: '100%' });
  assert.deepEqual(css.blocks.filter(({ selector }) => /reading-spark|spark-bloom/.test(selector)), []);
  assert.deepEqual(css.declarations.filter(({ selector, property }) => selector.includes('agent-brand-') && ['animation', 'transform'].includes(property)), []);
  assert.deepEqual(css.atRules.filter(rule => rule.includes('spark-bloom') || rule.startsWith('@keyframes ')), []);
  const node = ':not(.is-user, .is-claude, .is-codex) .reading-node';
  assertRule(css, `.reading-step${node}`, { 'box-shadow': 'inset 0 0 0 1.5px var(--node-tint)' });
  assertRule(css, `.reading-step.is-running${node}`, { 'box-shadow': 'inset 0 0 0 2px var(--node-tint)' });
  assertRule(css, `.reading-step.is-failed${node}`, { '--node-tint': 'var(--flow-fail)', 'box-shadow': 'inset 0 0 0 2px var(--node-tint)' });
  assert.equal(css.rule('.reading-node')['box-shadow'], undefined, 'the base node has no ring');
  assert.deepEqual(css.declarations.filter(({ property }) => property === 'animation'), []);
});
