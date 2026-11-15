// The one place that finds the programs in this repository standing in for the Claude Code or Codex CLI, and reads the
// registry that lists them (tests/fixtures/stand-ins.json). Used by tests/fake-cli-contract.test.cjs; there is no other scanner.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const REGISTRY_FILE = 'tests/fixtures/stand-ins.json';

// What a stand-in looks like from the inside, whichever language it is written in: it answers Codex's thread/start, it
// speaks Claude Code's control protocol or stream records, it is a compiled program with a Main, or it takes the provider
// from its first argument. A file that says none of this is not found, and a new stand-in that does is.
const SIGNATURE = /['"]thread\/start['"]|control_request|subtype: 'init'|static (?:void|int) Main|argv\[2\] === 'claude'|mode === 'claude'|argv\.includes\('app-server'\)/;
const SOURCE = /\.(?:c|m)?js$|\.cs$/;
// This file spells the signature out, and is not itself a stand-in.
const SELF = 'tests/helpers/stand-ins.cjs';

function discover(folders = ['tests', 'scripts']) {
  const found = [];
  for (const folder of folders) {
    for (const name of fs.readdirSync(path.join(root, folder), { recursive: true })) {
      const file = path.posix.join(folder, String(name).replaceAll('\\', '/'));
      if (!SOURCE.test(file) || /\.test\.(?:c|m)?js$/.test(file) || file === SELF || file.includes('node_modules/')) continue;
      if (SIGNATURE.test(fs.readFileSync(path.join(root, file), 'utf8'))) found.push(file);
    }
  }
  return found.sort();
}

const registry = () => JSON.parse(fs.readFileSync(path.join(root, REGISTRY_FILE), 'utf8'));

module.exports = { root, REGISTRY_FILE, SIGNATURE, discover, registry };
