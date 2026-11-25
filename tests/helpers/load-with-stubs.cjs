const { Module, createRequire } = require('node:module');
const path = require('node:path');

// Use the normal CommonJS loader with a fresh module and local dependency overrides.
function loadWithStubs(filename, stub) {
  const instance = new Module(filename);
  const load = createRequire(filename);
  instance.require = name => stub(name, load);
  instance.load(filename);
  return instance.exports;
}

function loadPreload(file, electron) {
  return loadWithStubs(path.resolve(__dirname, '../..', file), name => {
    if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
    return electron;
  });
}

module.exports = { loadWithStubs, loadPreload };
