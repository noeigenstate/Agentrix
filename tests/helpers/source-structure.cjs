const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function sourceNodes(file, select) {
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), ts.ScriptTarget.Latest, true);
  const matches = [];
  const visit = node => {
    if (select(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
}

function identifiers(file, names) {
  const wanted = new Set(names);
  return sourceNodes(file, node => ts.isIdentifier(node) && wanted.has(node.text)).map(node => node.text);
}

function stringUnion(file, name) {
  const [alias] = sourceNodes(file, node => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  const members = alias?.type && ts.isUnionTypeNode(alias.type) ? alias.type.types : [];
  return members.map(member => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : null);
}

function translationKeys(file) {
  return sourceNodes(file, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && node.expression.text === 't' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])).map(node => node.arguments[0].text);
}

const importsOf = file => sourceNodes(file, ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
const usesWindowMember = (file, member) => sourceNodes(file, node => ts.isPropertyAccessExpression(node)
  && ts.isIdentifier(node.expression) && node.expression.text === 'window' && node.name.text === member).length > 0;

module.exports = { sourceNodes, identifiers, stringUnion, translationKeys, importsOf, usesWindowMember };
