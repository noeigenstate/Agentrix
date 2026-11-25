const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');

const root = path.join(__dirname, '../..');
const atRule = node => `@${node.name}${node.params ? ` ${node.params}` : ''}`;

function readCss(file) {
  const from = path.resolve(root, file);
  return parseCss(fs.readFileSync(from, 'utf8'), from);
}

function parseCss(source, from) {
  const stylesheet = postcss.parse(source, { from });
  const blocks = [], atRules = [], declarations = [];
  const scopes = new Map();

  stylesheet.walk(node => {
    if (node.type === 'atrule') atRules.push(atRule(node));
    const nodes = node.nodes?.filter(child => child.type === 'decl') ?? [];
    if (node.type !== 'rule' && (node.type !== 'atrule' || !nodes.length)) return;
    const context = [];
    for (let parent = node.parent; parent.type !== 'root'; parent = parent.parent) {
      context.unshift(parent.type === 'atrule' ? atRule(parent) : parent.selector);
    }
    const selectors = node.type === 'rule' ? node.selectors : [atRule(node)];
    const selector = selectors.join(', ');
    const entries = nodes.map(child => [
      child.prop, child.important ? `${child.value} !important` : child.value,
    ]);
    const properties = Object.fromEntries(entries);
    blocks.push({ selector, selectors, context, properties });
    for (const [property, value] of entries) declarations.push({ selector, selectors, context, property, value });

    const scope = JSON.stringify(context);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const rules = scopes.get(scope);
    for (const key of new Set([selector, ...selectors])) {
      rules.set(key, { ...rules.get(key), ...properties });
    }
  });

  return {
    blocks, atRules, declarations,
    rule(selector, ...context) { return scopes.get(JSON.stringify(context))?.get(selector); },
  };
}

function assertRule(sheet, selector, properties, message = selector) {
  assert.partialDeepStrictEqual(sheet.rule(selector), properties, message);
}

module.exports = { readCss, parseCss, assertRule };
