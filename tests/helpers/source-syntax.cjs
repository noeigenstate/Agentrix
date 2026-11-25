const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function syntax(file) {
  const source = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function nodes(root, predicate) {
  const selected = [];
  function visit(node) {
    if (predicate(node)) selected.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return selected;
}

module.exports = { ts, syntax, nodes };
