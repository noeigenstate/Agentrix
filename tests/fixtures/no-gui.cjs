// Refusal tests must never reach a browser, Electron, or a native clipboard process.
const Module = require('node:module');
const processes = require('node:child_process');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  processes[method] = () => { throw new Error('GUI_LAUNCH_ATTEMPT: ' + method); };
}
Module.syncBuiltinESMExports();
const original = Module._load;
Module._load = function (name, ...args) {
  if (/^(electron|playwright|playwright-core)$/.test(name)) throw new Error('GUI_LAUNCH_ATTEMPT: ' + name);
  return original.call(this, name, ...args);
};
