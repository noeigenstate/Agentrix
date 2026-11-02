// Reuse the trusted executor with Windows' standard input pipe; no Unix fd inheritance is assumed.
const fs = require('node:fs');
const path = require('node:path');
let source = fs.readFileSync(path.join(__dirname, 'executor.cjs'), 'utf8');
for (const [from, to] of [
  ["const input = fs.createReadStream(null, { fd: 3, autoClose: false, encoding: 'utf8' });", "const input = process.stdin; input.setEncoding('utf8');"],
  ['fs.closeSync(3);', ''],
  ["fs.writeSync(4, '1')", 'fs.writeSync(2, startMarker)'],
  ['const { config, bootstrap, modules } = payload;',
    'const { config, bootstrap, modules } = payload; startMarker = config.startMarker; delete config.startMarker; ' +
    'Object.assign(process.env, config.isolatedEnvironment); delete config.isolatedEnvironment;'],
]) {
  if (!source.includes(from)) throw new Error('The trusted lab executor has changed.');
  source = source.replace(from, to);
}
module._compile('let startMarker;\n' + source, path.join(__dirname, 'executor.cjs'));
