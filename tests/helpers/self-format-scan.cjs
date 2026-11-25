const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { ROOT } = require('./guard-baselines.cjs');

const SCRIPT = /\.[cm]?[jt]sx?$/;
const PRODUCT = /^(?:electron|integration|src|scripts)\//;
const SCREEN = /^src\/features\/cli-screens\//;
const READ_FILE = /^(?:readFileSync|readFile|readTextFile|ReadAllText|ReadAllLines)$/;
const MARKDOWN = /(?:#{1,3}(?:[ \t]|\\[snt]|\(\?=)|#\{(?:[123]|1,[123])\}|Needs decision|Findings for the ledger)/;
const LINE_SPLIT = /^(?:\/\\r\?\\n\/|\/\\n\/|'\\n'|"\\n")$/;

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, child => visit(child, fn));
}

function name(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return ts.isIdentifier(expression) ? expression.text : '';
}

function call(node, methods) {
  return ts.isCallExpression(node) && methods.test(name(node.expression));
}

function collect(node, select) {
  const found = [];
  if (node) visit(node, child => { const value = select(child); if (value) found.push(value); });
  return found;
}

function positional(node, checker) {
  const readsLines = expression => {
    if (call(expression, /^split$/)) return LINE_SPLIT.test(expression.arguments[0]?.getText() ?? '');
    return ts.isIdentifier(expression) && (checker.getSymbolAtLocation(expression)?.declarations ?? [])
      .some(declaration => declaration.initializer && call(declaration.initializer, /^split$/) && readsLines(declaration.initializer));
  };
  return ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression) && readsLines(node.expression)
    || ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && readsLines(node.initializer);
}

function markdownReader(node, checker) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = name(node.expression);
  const values = /^(?:indexOf|split|matchAll|match|search)$/.test(method) ? node.arguments
    : /^(?:test|exec)$/.test(method) ? [node.expression.expression] : [];
  return values.some(value => {
    const pattern = ts.isIdentifier(value) ? initializer(value, checker) : value;
    return pattern && (ts.isStringLiteralLike(pattern) || ts.isRegularExpressionLiteral(pattern)) && MARKDOWN.test(pattern.getText());
  });
}

function dispatchReader(node, checker) {
  if (!call(node, /^(?:startsWith|includes|indexOf)$/)) return false;
  const arg = node.arguments[0];
  if (!arg) return false;
  const prefix = ts.isIdentifier(arg) ? initializer(arg, checker) : arg;
  return prefix && /^['"`]\[dispatch\]/.test(prefix.getText());
}

function productFindings(source, file, checker) {
  const findings = [];
  const lines = source.split('\n').filter(line => !/^\s*(?:\/\/|\/\*|\*\s|#\s)/.test(line)).join('\n');
  const patterns = {
    'dispatch-text': /\/\^?[^/\n]{0,80}\\\[dispatch\\\][^/\n]*\/|\/[^/\n]*\breason (?:\[|\()[^/\n]*\//g,
    'whole-word': /\.trim\(\)\s*[!=]={1,2}\s*(['"])[a-z][a-z0-9_-]*\1|\$\(\s*cat\b[^\n]*?\)\s*["']?\s*(?:==?|!=)\s*["']?[a-z][\w-]*\b/gi,
    'word-marker': /\b(?:word|words\[\$\w+\])\s*(?:-ceq|-eq|===?)\s*['"](?:--|-u)['"]|\$(?:word|entry)["']?\s*(?:==?|!=)\s*['"]?(?:--|-u)(?=['"\s])/g,
    'ordered-shell-lines': /\bIFS= read -r \w+[^\n]*&&\s*IFS= read -r \w+/g,
    'note-marker': /\.(?:indexOf|split|partition)\(\s*(?:['"] Agentrix skill delivery: ['"]|(?:claudeWire\.)?note\.marker)/g,
  };
  for (const [rule, pattern] of Object.entries(patterns)) for (const _match of lines.matchAll(pattern)) findings.push(rule);
  if (file === 'scripts/routing-acceptance.mjs') {
    for (const _match of lines.matchAll(/\/[^/\n]*(?: routing ok |scope ok\|OUT OF SCOPE)[^/\n]*\//g)) findings.push('dispatch-text');
  }
  if (/\.(?:bash|zsh|py)$/.test(file) && /\broute=\$\([^\n]*\bclassify\b/.test(lines)) {
    for (const _match of lines.matchAll(/\bcase\s+["']?\$route["']?\s+in|\$route["']?\s*(?:==?|!=)\s*["']?[a-z][\w-]*\b/g)) {
      findings.push('whole-word');
    }
  }
  if (/\.ps1$/.test(file)) {
    for (const _match of lines.matchAll(/\.mode['"][^\n]*?\)\s*-(?:c|i)?(?:eq|ne)\s*['"][a-z][\w-]*['"]/gi)) findings.push('whole-word');
    if (/\bInvoke-AgentrixLaunchPlan\b[^\n]*['"]classify['"]/.test(lines)) {
      for (const _match of lines.matchAll(/\$route(?:\.Trim\(\))?\s*-(?:c|i)?(?:eq|ne)\s*['"][a-z][\w-]*['"]/gi)) findings.push('whole-word');
    }
    for (const match of lines.matchAll(/\$(\w+)\s*=\s*[^\n]*?\bReadAllLines\s*\(/g)) {
      const indexing = new RegExp(`\\$${match[1]}\\s*\\[(?:\\d+|\\$\\w+)\\]`, 'g');
      for (const _index of lines.matchAll(indexing)) findings.push('positional-lines');
    }
  }
  if (!SCRIPT.test(file)) return findings;
  visit(checker.getSourceFile(path.join(ROOT, file)), node => {
    if (markdownReader(node, checker.symbols)) findings.push('heading-text');
    if (dispatchReader(node, checker.symbols)) findings.push('dispatch-text');
    if (positional(node, checker.symbols)) findings.push('positional-lines');
  });
  return findings;
}

function repoPath(text, file) {
  const portable = text.replaceAll('\\', '/');
  const direct = /(?:^|\/)((?:electron|integration|src|scripts)\/[^\s'"`]+)$/.exec(portable)?.[1];
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), portable));
  return [direct, relative].find(candidate => candidate && PRODUCT.test(candidate) && fs.existsSync(path.join(ROOT, candidate))
    && fs.statSync(path.join(ROOT, candidate)).isFile());
}

function initializer(node, checker) {
  return checker.getSymbolAtLocation?.(node)?.declarations?.[0]?.initializer;
}

function pathsIn(node, checker, file, seen = new Set()) {
  if (seen.has(node)) return [];
  seen.add(node);
  return collect(node, child => {
    if (ts.isStringLiteralLike(child) || ts.isTemplateLiteralToken(child)) return repoPath(child.text, file);
    if (ts.isIdentifier(child)) return pathsIn(initializer(child, checker), checker, file, seen);
  }).flat();
}

function readsFile(expression, checker) {
  if (call(expression, READ_FILE)) return true;
  const declaration = checker.getSymbolAtLocation(expression.expression)?.declarations?.[0];
  const body = declaration?.body ?? declaration?.initializer?.body;
  return collect(body, child => call(child, READ_FILE)).length > 0;
}

// Follow source text through local bindings, slices, concatenation and compiler transformations.
function sourceTargets(node, checker, file, seen = new Set()) {
  if (seen.has(node)) return [];
  seen.add(node);
  if (node && ts.isCallExpression(node) && readsFile(node, checker)) {
    return pathsIn(node.arguments[0], checker, file);
  }
  if (node && ts.isIdentifier(node)) return sourceTargets(initializer(node, checker), checker, file, seen);
  return collect(node, child => child !== node && (ts.isCallExpression(child) || ts.isIdentifier(child))
    ? sourceTargets(child, checker, file, seen) : null).flat();
}

function testFindings(tree, checker, file) {
  const findings = [];
  visit(tree, node => {
    const vm = call(node, /^(?:runIn(?:New|This)?Context|compileFunction)$/) || ts.isNewExpression(node) && name(node.expression) === 'Function';
    const regexAssertion = call(node, /^(?:match|doesNotMatch)$/) && node.arguments.length >= 2 && /^assert\b/.test(node.expression.getText());
    const slice = call(node, /^(?:slice|substring)$/) && ts.isPropertyAccessExpression(node.expression) && node.arguments.some(argument => {
      const bound = ts.isIdentifier(argument) ? initializer(argument, checker) : argument;
      return collect(bound, child => call(child, /^indexOf$/)
        && /^[`'"](?:\s*)(?:async\s+|function\s+|const\s+|let\s+|export\s+)/.test(child.arguments[0]?.getText())).length > 0;
    });
    const rule = vm ? 'source-execution' : regexAssertion ? 'source-regex' : slice ? 'source-slice' : null;
    if (!rule) return;
    const input = slice ? node.expression.expression : node.arguments?.[0];
    const targets = new Set(sourceTargets(input, checker, file));
    for (const target of targets) if (!SCREEN.test(target)) findings.push(`${target} :: ${file} :: ${rule}`);
  });
  return findings;
}

function scan(product, tests) {
  const files = [...product.filter(file => SCRIPT.test(file)), ...tests];
  const program = ts.createProgram(files.map(file => path.join(ROOT, file)), { allowJs: true, noResolve: true, noLib: true, types: [] });
  const checker = { getSourceFile: file => program.getSourceFile(file), symbols: program.getTypeChecker() };
  const counts = {};
  for (const file of product) {
    for (const rule of productFindings(fs.readFileSync(path.join(ROOT, file), 'utf8'), file, checker)) {
      const key = `${file} :: ${rule}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  for (const file of tests) for (const key of testFindings(checker.getSourceFile(path.join(ROOT, file)), checker.symbols, file)) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

module.exports = { scan, productFindings, testFindings };
