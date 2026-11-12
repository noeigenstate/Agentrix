const path = require('node:path');

// A file system of named files for claude-runtime's locator (its `files` option), in the path rules of `platform`, so
// a Windows layout is tested on any host and no real file is read. A file is { size?, text?, mtimeMs?, link? }; `link`
// is where its realpath leads. `calls` counts each kind of call; `put` and `remove` change files between searches.
function fakeFiles(entries = {}, platform = 'win32') {
  const rules = platform === 'win32' ? path.win32 : path.posix;
  const key = file => { const resolved = rules.resolve(file); return platform === 'win32' ? resolved.toUpperCase() : resolved; };
  const files = new Map(), calls = { realpath: 0, stat: 0, access: 0, readFile: 0 };
  const put = (file, value) => files.set(key(file), { file: rules.resolve(file), ...value });
  for (const [file, value] of Object.entries(entries)) put(file, value);
  const get = file => files.get(key(file)) ?? (() => { throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); })();
  return {
    calls, put, remove: file => files.delete(key(file)),
    realpath: async file => { calls.realpath++; const found = get(file); return found.link ? rules.resolve(found.link) : found.file; },
    stat: async file => { calls.stat++; const found = get(file); return { isFile: () => true, size: found.size ?? Buffer.byteLength(found.text ?? ''), mtimeMs: found.mtimeMs ?? 1 }; },
    access: async file => { calls.access++; get(file); },
    readFile: async file => { calls.readFile++; return get(file).text ?? ''; },
  };
}

// A probe (the locator's `probe`) that answers `--version` from `versions` (file → output; `fallback` for any other)
// and records every file it ran.
function fakeProbe(versions = {}, fallback = '2.1.322 (Claude Code)') {
  const runs = [];
  const probe = (file, _args, _options, callback) => { runs.push(file); callback(null, versions[file] ?? fallback); };
  return { probe, runs };
}

const NATIVE = 346496160, STUB = 500;
// npm's cmd-shim for its package's bin/claude.exe, as `npm install -g @anthropic-ai/claude-code` writes it.
const NPM_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

module.exports = { fakeFiles, fakeProbe, NATIVE, STUB, NPM_SHIM };
