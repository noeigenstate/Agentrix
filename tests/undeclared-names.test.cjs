const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// A name read in one function and declared only inside another is a ReferenceError the first time that line runs, and no
// unit test that stubs the name sees it (1.4.0-beta.1: folderOf in the native history read). TypeScript resolves every
// identifier of the main-process sources against its enclosing scopes; nothing here is run or imported.
const root = path.resolve(__dirname, '..').replaceAll('\\', '/');
// What Node and Electron's main process provide beyond the language itself. Anything else must be declared or required.
const hostGlobals = new Set(['AbortController', 'AbortSignal', 'Buffer', 'ReadableStream', 'Response', 'URL', '__dirname',
  'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'fetch', 'module', 'performance', 'process', 'queueMicrotask',
  'setImmediate', 'setInterval', 'setTimeout', 'structuredClone']);
// Only the language's own globals come from TypeScript: no Node or DOM typings, and no module is followed.
const options = { allowJs: true, checkJs: true, noEmit: true, noResolve: true, types: [], lib: ['lib.es2023.d.ts'],
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, moduleDetection: ts.ModuleDetectionKind.Force };
const unresolved = /^(?:Cannot find name|No value exists in scope for the shorthand property) '([^']+)'|^'([^']+)' only refers to a type, but is being used as a value/;
// A source that exists only here proves the scan still reports the bug it guards against.
const probe = `${root}/tests/undeclared-names.probe.cjs`;
const probeSource = `function declares() { const inner = 1; return inner; }
function reads() { return inner + process.pid; }
module.exports = { declares, reads, shorthand: () => ({ missing }) };
`;

function undeclaredNames() {
  const files = fs.readdirSync(`${root}/electron`, { recursive: true }).map(file => `${root}/electron/${file.replaceAll('\\', '/')}`)
    .filter(file => /\.[cm]js$/.test(file)).concat(probe);
  const host = ts.createCompilerHost(options), { readFile, fileExists } = host;
  host.readFile = file => file === probe ? probeSource : readFile(file);
  host.fileExists = file => file === probe || fileExists(file);
  const program = ts.createProgram(files, options, host);
  return files.flatMap(name => {
    const file = program.getSourceFile(name);
    return program.getSemanticDiagnostics(file).flatMap(diagnostic => {
      const match = unresolved.exec(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')), found = match?.[1] || match?.[2];
      if (!found || hostGlobals.has(found)) return [];
      return [`${name.slice(root.length + 1)}:${file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} ${found}`];
    });
  });
}

test('every name the main process reads is declared in a scope that line can see', () => {
  const found = undeclaredNames(), ofProbe = line => line.startsWith('tests/undeclared-names.probe.cjs:');
  assert.deepEqual(found.filter(ofProbe), ['tests/undeclared-names.probe.cjs:2 inner', 'tests/undeclared-names.probe.cjs:3 missing'],
    'the scan no longer reports a name declared only inside another function');
  assert.deepEqual(found.filter(line => !ofProbe(line)), [],
    'declare each name where its reader can see it, or add a real Node/Electron global to hostGlobals');
});
