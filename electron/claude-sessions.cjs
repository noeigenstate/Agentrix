const { adapterOf } = require('./features/cli-adapters/registry.cjs');

module.exports = adapterOf('claude').transcript.sessions;
