// Runs under the model's filesystem policy. Private code and the metering capability arrive over a one-use pipe.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { meterSink } = require('./meter-sink.cjs');

function memoryModules(sources) {
  const cache = new Map(), root = __dirname;
  const builtin = new Set(Module.builtinModules.flatMap(name => [name, 'node:' + name]));
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    if (typeof sources[name] !== 'string') throw new Error('Missing trusted dispatch module: ' + name);
    const filename = path.join(root, name), mod = new Module(filename, module);
    mod.filename = filename; mod.paths = []; cache.set(name, mod);
    mod.require = specifier => {
      if (builtin.has(specifier)) return require(specifier);
      if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
        throw new Error('Unbundled dispatch dependency: ' + specifier);
      }
      const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(path.dirname(filename), specifier);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const target = [relative, relative + '.cjs', relative + '.js'].find(candidate => Object.hasOwn(sources, candidate));
      if (!target) throw new Error('Missing trusted dispatch dependency.');
      return load(target);
    };
    mod._compile(sources[name], filename);
    return mod.exports;
  }
  return load('dispatch.cjs');
}

function launch(file, args, options, model = false) {
  const env = { ...options.env };
  delete env.AGENTRIX_BOOTSTRAP; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = spawn(file, args, { ...options, env, detached: false });
  // Only the trusted launcher can write this pipe; native model processes inherit stdio 0..2 only.
  if (model) child.once('spawn', () => fs.writeSync(4, '1'));
  return child;
}

async function execute(payload) {
  const { config, bootstrap, modules } = payload;
  globalThis.__AGENTRIX_LAB_SINK = meterSink(bootstrap);
  if (bootstrap && !await globalThis.__AGENTRIX_LAB_SINK({ type: 'lab-handshake' })) {
    throw new Error('Authenticated lab metering is unavailable. No model worker was started.');
  }
  if (!config.command) return memoryModules(modules).run(config.args, {
    env: process.env, launch: (file, args, options) => launch(file, args, options, true),
  });
  const child = launch(config.command.file, config.command.args, {
    cwd: config.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code ?? 1));
  });
}

let data = '';
const input = fs.createReadStream(null, { fd: 3, autoClose: false, encoding: 'utf8' });
input.on('data', chunk => {
  data += chunk;
  if (data.length > 16 * 1024 * 1024) input.destroy(new Error('Trusted dispatch payload is too large.'));
});
input.on('error', error => { console.error(error.message); process.exitCode = 1; });
input.on('end', () => {
  fs.closeSync(3);
  let payload;
  try { payload = JSON.parse(data); data = ''; }
  catch { console.error('Invalid trusted dispatch payload.'); process.exitCode = 1; return; }
  void execute(payload).then(code => { process.exitCode = code; }, error => {
    console.error(error.message); process.exitCode = 1;
  });
});
