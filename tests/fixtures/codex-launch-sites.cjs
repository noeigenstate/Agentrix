const ts = require('typescript'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = text => crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24);
const launch = /^(?:spawn|spawnSync|spawnProcess|launch|exec|execSync|execFile|execFileSync|resolveExecutable|resolveCli|Popen|run)$/;
const terminal = /^(?:write|writeTerminal|terminalWrite|afterPrompt|input|sendToAgent)$/;
function calls(source, file = 'sample.cjs') {
  if (file.endsWith('.py')) {
    const result = spawnSync('python', ['-c', `import ast,json,sys
s=sys.stdin.read(); t=ast.parse(s)
print(json.dumps([ast.get_source_segment(s,n) for n in ast.walk(t) if isinstance(n,ast.Call) and ((isinstance(n.func,ast.Attribute) and n.func.attr in ('Popen','run','call','check_call','check_output','system','execv','execve','spawnv','write','input')) or (isinstance(n.func,ast.Name) and n.func.id in ('Popen','run','call','check_call','check_output','system','execv','execve','spawnv')))]))
`], { input: source, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).map(text => ({ text, id: file + ':' + hash(text) }));
  }
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), sites = [], aliases = new Set();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const original = ts.isPropertyAccessExpression(node.initializer) ? node.initializer.name.text : node.initializer.getText(root);
      if (ts.isIdentifier(node.name) && (launch.test(original) || aliases.has(original))) aliases.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
        if (launch.test(binding.propertyName?.getText(root) || binding.name.getText(root))) aliases.add(binding.name.getText(root));
      }
    }
    if (ts.isImportSpecifier(node) && launch.test(node.propertyName?.text || node.name.text)) aliases.add(node.name.text);
    ts.forEachChild(node, collect);
  }
  collect(root);
  const constant = node => ts.isStringLiteralLike(node) ? node.text : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? (constant(node.left) ?? '') + (constant(node.right) ?? '') : null;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(root);
      if (launch.test(callee) || terminal.test(callee) || aliases.has(callee)) sites.push(node);
    }
    if (ts.isArrayLiteralExpression(node) && constant(node.elements[0] || root) === 'exec') sites.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return sites.map(node => {
    let scope = node.parent;
    while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return { text: node.getText(root), id: file + ':' + hash((scope?.getText(root) || '') + '\n' + node.getText(root)) };
  });
}
function violations(source, file, allow = new Set()) { return calls(source, file).filter(site => !allow.has(site.id)); }
module.exports = { calls, violations };
