const manifest = require('./manifest.json');
const { createProvider } = require('./provider.cjs');

function createOssSource(options = {}) {
  // The alternate manifest and interpreter are used by portable offline fixtures; production uses the shipped pins
  // and the Python runtime allowed by LabSession. Providers never start a process or a network request themselves.
  return createProvider(options.manifest || manifest, options.python);
}

module.exports = { createOssSource };
