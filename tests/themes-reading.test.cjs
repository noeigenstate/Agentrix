const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { THEMES } = require('../src/shared/themes.ts');

const read = file => postcss.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
const themes = read('src/shared/styles/themes.css'), reading = read('src/features/reading/reading.css');
const workbench = '.workspace-layout:not(:has(> .home-layer))';

function declarations(sheet, selector) {
  const values = {};
  sheet.walkRules(rule => {
    if (rule.selector === selector) rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
  });
  return values;
}

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
  const composer = declarations(reading, '.reading-composer');
  const input = { ...declarations(reading, '.reading-composer textarea'), ...declarations(reading, '.reading-composer textarea:disabled') };
  const placeholder = { ...declarations(reading, '.reading-composer textarea::placeholder'), ...declarations(reading, '.reading-composer textarea:disabled::placeholder') };
  for (const { id } of THEMES) {
    const theme = `:root[data-theme="${id}"]`;
    const tokens = { ...declarations(themes, ':root'), ...declarations(themes, theme),
      ...declarations(themes, workbench), ...declarations(themes, `${theme} ${workbench}`) };
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
