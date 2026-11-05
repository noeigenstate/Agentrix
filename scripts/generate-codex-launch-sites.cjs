// The generated diff is the review surface: generation alone does not approve a new launch.
const fs = require('node:fs'), path = require('node:path');
const { calls } = require('../tests/fixtures/codex-launch-sites.cjs');
const root = path.resolve(__dirname, '..');
function files(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? files(file) : /\.(?:cjs|js|ts|tsx|py)$/.test(file) ? [file] : [];
  });
}
const sites = ['electron', 'integration', 'src'].flatMap(folder => files(path.join(root, folder))).flatMap(file =>
  calls(fs.readFileSync(file, 'utf8'), path.relative(root, file).split(path.sep).join('/')));
const unique = [...new Map(sites.map(site => [site.id, site])).values()];
const target = path.join(root, 'tests/fixtures/codex-launch-sites.json');
if (!process.argv.includes('--write')) throw new Error('Use --write, then review the launch-site JSON diff before accepting it.');
fs.writeFileSync(target, JSON.stringify(unique, null, 2) + '\n');
console.log(`Wrote ${unique.length} call fingerprints; review tests/fixtures/codex-launch-sites.json.`);
