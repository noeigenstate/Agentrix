// Reuse the trusted executor with Windows' standard input pipe; no Unix fd inheritance is assumed.
const fs = require('node:fs');
const path = require('node:path');
let source = fs.readFileSync(path.join(__dirname, 'executor.cjs'), 'utf8');
for (const [from, to] of [
  ["const input = fs.createReadStream(null, { fd: 3, autoClose: false, encoding: 'utf8' });",
    "trace('input wait'); const input = process.stdin; input.setEncoding('utf8');"],
  ["input.on('data', chunk => {", "input.on('data', chunk => { if (!tracedInput) { trace('input first bytes=' + Buffer.byteLength(chunk)); tracedInput = true; }"],
  ["input.on('end', () => {", "input.on('end', () => { trace('input end chars=' + data.length);"],
  ['fs.closeSync(3);', 'input.destroy();'],
  ["fs.writeSync(4, '1')", 'fs.writeSync(2, startMarker)'],
  ['const { config, bootstrap, modules } = payload;',
    'const { config, bootstrap, modules } = payload; startMarker = config.startMarker; delete config.startMarker; ' +
    "Object.assign(process.env, config.isolatedEnvironment); delete config.isolatedEnvironment; trace('payload parsed');"],
  ['const child = spawn(file, args, { ...options, env, detached: false });',
    "const child = spawn(file, args, { ...options, env, detached: false }); " +
    "child.once('spawn', () => trace('child spawned pid=' + child.pid)); " +
    "child.once('error', error => trace('child error code=' + error.code)); " +
    "child.once('exit', code => trace('child exit code=' + code));"],
  ['void execute(payload).then(code => { process.exitCode = code; }, error => {',
    "void execute(payload).then(code => { trace('complete code=' + code); process.exitCode = code; }, error => { trace('execute failed');"],
]) {
  if (!source.includes(from)) throw new Error('The trusted lab executor has changed.');
  source = source.replace(from, to);
}
const prelude = `let startMarker, tracedInput = false;
const diagnostic = process.env.AGENTRIX_LAB_DIAGNOSTICS === '1';
delete process.env.AGENTRIX_LAB_DIAGNOSTICS;
function trace(message) { if (diagnostic) process.stderr.write('[lab-win32] executor ' + message + '\\n'); }
trace('entry');
`;
module._compile(prelude + source, path.join(__dirname, 'executor.cjs'));
