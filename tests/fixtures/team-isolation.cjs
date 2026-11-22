// Test processes opt into a general write boundary; the product has no test-mode branch.
const path = require('node:path'), os = require('node:os');
const { withoutShims } = require('../../electron/shared/agentrix-shims.cjs');
const root = path.resolve(__dirname, '../..');
const writeRoots = [os.tmpdir(), path.join(root, '.test-output')].join(path.delimiter);
process.env.AGENTRIX_TEAM_WRITE_ROOTS = writeRoots;
process.env.GIT_CEILING_DIRECTORIES = [...new Set([...(process.env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter).filter(Boolean), os.tmpdir(), root])].join(path.delimiter);

function dispatchEnvironment() {
  const env = withoutShims(process.env);
  for (const name of Object.keys(env)) if (/^AGENTRIX_/i.test(name)) delete env[name];
  return { ...env, AGENTRIX_TEAM_WRITE_ROOTS: writeRoots };
}

module.exports = { dispatchEnvironment };
