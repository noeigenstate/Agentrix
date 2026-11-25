const test = require('node:test');
const assert = require('node:assert/strict');
const { readCss } = require('./helpers/css-rules.cjs');
const { THEMES } = require('../src/shared/themes.ts');

const themes = readCss('src/shared/styles/themes.css'), reading = readCss('src/features/reading/reading.css');
const workbench = '.workspace-layout:not(:has(> .home-layer))';

function color(value, tokens) {
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) return color(tokens[variable[1]], tokens);
  assert.match(value, /^#[\da-f]{6}$/i, `expected an opaque theme color, got ${value}`);
  return value.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
}

function contrast(foreground, background, opacity) {
  const ink = foreground.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
  const luminance = rgb => rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const light = luminance(ink), surface = luminance(background);
  return (Math.max(light, surface) + 0.05) / (Math.min(light, surface) + 0.05);
}

test('disabled reading composer text remains legible in every theme', () => {
  const composer = reading.rule('.reading-composer');
  const input = { ...reading.rule('.reading-composer textarea'), ...reading.rule('.reading-composer textarea:disabled') };
  const placeholder = { ...reading.rule('.reading-composer textarea::placeholder'), ...reading.rule('.reading-composer textarea:disabled::placeholder') };
  for (const { id } of THEMES) {
    const theme = `:root[data-theme="${id}"]`;
    const tokens = { ...themes.rule(':root'), ...themes.rule(theme), ...themes.rule(workbench), ...themes.rule(`${theme} ${workbench}`) };
    const background = color(composer.background, tokens);
    const opacity = Number(composer.opacity ?? 1) * Number(input.opacity ?? 1);
    for (const [label, value, alpha] of [
      ['text', input.color, opacity],
      ['placeholder', placeholder.color, opacity * Number(placeholder.opacity ?? 1)],
    ]) {
      const ratio = contrast(color(value, tokens), background, alpha);
      assert.ok(ratio >= 4.5, `${id} disabled ${label}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('the light theme fills the owner message on the feed itself, which sets its own card token', () => {
  const flow = readCss('src/features/reading/reading-flow.css');
  const override = themes.blocks.some(({ selector, properties }) => Object.hasOwn(properties, '--flow-card')
    && selector.includes('light') && selector.includes('.conversation-feed') && selector.includes('.reading-view'));
  assert.ok(override, 'the nearest element defining --flow-card wins, so the light override must name .conversation-feed too');
  assert.equal(flow.rule(':is(.reading-view, .conversation-feed)')['--flow-card'], 'var(--bg-input)');
});
