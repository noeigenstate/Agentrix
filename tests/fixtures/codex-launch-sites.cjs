const ts = require('typescript'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { findPython } = require('../../scripts/python-command.cjs');
let python;
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
const signature = text => { const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text); const tokens = []; for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) tokens.push([kind, scanner.getTokenText().replace(/\r\n/g, '\n')]); return JSON.stringify(tokens); };
const launch = /^(?:spawn|spawnSync|spawnProcess|launch|exec|execSync|execFile|execFileSync|resolveExecutable|resolveCli|Popen|run)$/;
const terminal = /^(?:write|writeTerminal|terminalWrite|afterPrompt|input|sendToAgent)$/;
function calls(source, file = 'sample.cjs') {
  if (file.endsWith('.py')) {
    python ||= findPython();
    // ast.dump's wording follows the interpreter (newer ones leave out empty lists and Load contexts), so an id made from it
    // names the Python that wrote the list. dump() below writes the tree the way that list was written, on any version.
    const result = spawnSync(python.command, [...python.args, '-c', `import ast,json,sys,re
s=sys.stdin.read(); t=ast.parse(s)
names=set(('Popen','run','call','check_call','check_output','system','execv','execve','spawnv'))
for n in ast.walk(t):
 if isinstance(n,ast.ImportFrom):
  for a in n.names:
   if a.name in names: names.add(a.asname or a.name)
 if isinstance(n,ast.Assign) and ((isinstance(n.value,ast.Attribute) and n.value.attr in names) or (isinstance(n.value,ast.Name) and n.value.id in names)):
  names.update(a.id for a in n.targets if isinstance(a,ast.Name))
def launch(n):
 if not isinstance(n,ast.Call): return False
 f=n.func; text=ast.get_source_segment(s,n)
 if isinstance(f,ast.Attribute):
  if f.attr in names: return True
  receiver=ast.get_source_segment(s,f.value)
  return f.attr=='write' and (receiver=='os' or re.search(r'(terminal|pty|gate)$',receiver,re.I) or re.search(r'codex|--remote|resume',text))
 return isinstance(f,ast.Name) and f.id in names
def dump(n):
 if isinstance(n,list): return '[%s]'%', '.join(dump(v) for v in n)
 if not isinstance(n,ast.AST): return repr(n)
 literal=isinstance(n,(ast.Constant,ast.MatchSingleton))
 return '%s(%s)'%(type(n).__name__,', '.join('%s=%s'%(k,dump(v)) for k,v in ast.iter_fields(n) if v is not None or literal and k=='value'))
print(json.dumps([[ast.get_source_segment(s,n),dump(n)] for n in ast.walk(t) if launch(n)]))
`], { input: source, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).map(([text, syntax]) => ({ text, id: file + ':' + hash(syntax) }));
  }
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), sites = [], aliases = new Set(), regexes = new Set(), processNamespaces = new Set();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && /require\(['"](?:node:)?child_process['"]\)/.test(node.initializer.getText(root))) processNamespaces.add(node.name.text);
      if (ts.isRegularExpressionLiteral(node.initializer) || ts.isNewExpression(node.initializer) && node.initializer.expression.getText(root) === 'RegExp') regexes.add(node.name.getText(root));
      const original = ts.isPropertyAccessExpression(node.initializer) ? node.initializer.name.text : node.initializer.getText(root);
      if (ts.isIdentifier(node.name) && (launch.test(original) || aliases.has(original))) aliases.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
        if (launch.test(binding.propertyName?.getText(root) || binding.name.getText(root))) aliases.add(binding.name.getText(root));
      }
    }
    if (ts.isImportSpecifier(node) && launch.test(node.propertyName?.text || node.name.text)) aliases.add(node.name.text);
    if (ts.isImportDeclaration(node) && /(?:^|:)child_process$/.test(node.moduleSpecifier.text || '') && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) processNamespaces.add(node.importClause.namedBindings.name.text);
    ts.forEachChild(node, collect);
  }
  collect(root);
  const constant = node => ts.isStringLiteralLike(node) ? node.text : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? (constant(node.left) ?? '') + (constant(node.right) ?? '') : null;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : node.expression.getText(root);
      const receiver = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : null;
      const regular = callee === 'exec' && receiver && (!processNamespaces.has(receiver.getText(root)) && !/docker|require\(['"](?:node:)?child_process['"]\)/.test(receiver.getText(root)) || ts.isRegularExpressionLiteral(receiver) || regexes.has(receiver.getText(root))
        || ts.isNewExpression(receiver) && receiver.expression.getText(root) === 'RegExp');
      const terminalWrite = callee === 'write' && receiver && (/(?:terminal|pty|gate)(?:\?\.)?$/i.test(receiver.getText(root))
        || node.arguments.some(argument => /codex|--remote|\bresume\b/.test(argument.getText(root))));
      if (!regular && (launch.test(callee) || terminal.test(callee) && (callee !== 'write' || terminalWrite) || aliases.has(callee))) sites.push(node);
    }
    if (ts.isArrayLiteralExpression(node) && constant(node.elements[0] || root) === 'exec') sites.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return sites.map(node => ({ text: node.getText(root), id: file + ':' + hash(signature(node.getText(root))) }));
}
function violations(source, file, allow = new Set()) { return calls(source, file).filter(site => !allow.has(site.id)); }
module.exports = { calls, violations };
