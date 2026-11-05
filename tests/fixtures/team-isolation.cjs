// Test processes opt into a general write boundary; the product has no test-mode branch.
const path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '../..');
process.env.AGENTRIX_TEAM_WRITE_ROOTS = [os.tmpdir(), path.join(root, '.test-output')].join(path.delimiter);
process.env.GIT_CEILING_DIRECTORIES = [...new Set([...(process.env.GIT_CEILING_DIRECTORIES || '').split(path.delimiter).filter(Boolean), os.tmpdir(), root])].join(path.delimiter);
