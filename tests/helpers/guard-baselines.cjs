const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boundaryFiles, parseBoundary, globRegExp } = require('../../scripts/module-boundaries.cjs');

const ROOT = path.join(__dirname, '../..');

function moduleOfFile() {
  const owners = boundaryFiles(ROOT).flatMap(file => {
    const { sections } = parseBoundary(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const module = file.replace(/\/BOUNDARY\.md$/, '').replaceAll('/', '--');
    return sections.Owns.map(entry => [globRegExp(entry.split('`')[1]), module]);
  });
  return file => {
    const owner = owners.find(([pattern]) => pattern.test(file))?.[1];
    if (owner) return owner;
    // The top-level launch scripts and the SSH worker are independent of Dispatch.
    if (file.startsWith('integration/')) return `integration--${path.posix.basename(file, path.posix.extname(file))}`;
    return file.split('/').slice(0, 3).filter(segment => !segment.includes('.')).join('--');
  };
}

function walk(folder, excluded = () => false) {
  return fs.readdirSync(path.join(ROOT, folder), { withFileTypes: true }).flatMap(entry => {
    const file = `${folder}/${entry.name}`;
    if (excluded(file, entry)) return [];
    return entry.isDirectory() ? walk(file, excluded) : entry.isFile() ? [file] : [];
  });
}

function loadBaseline(folder, moduleOf) {
  const directory = path.join(ROOT, folder);
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => {
    const data = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    assert.match(name, /^[\w-]+\.json$/);
    assert.ok(Object.keys(data).length, `${folder}/${name} has no entries`);
    for (const [key, count] of Object.entries(data)) {
      assert.equal(name, `${moduleOf(key)}.json`, `${key} belongs in its own module baseline`);
      assert.ok(Number.isSafeInteger(count) && count > 0, `Invalid baseline count for ${key}`);
    }
    return [name, data];
  }));
}

function writeBaseline(folder, actual, moduleOf) {
  const directory = path.join(ROOT, folder), groups = new Map();
  for (const key of Object.keys(actual).sort()) {
    const name = `${moduleOf(key)}.json`;
    if (!groups.has(name)) groups.set(name, {});
    groups.get(name)[key] = actual[key];
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, data] of groups) {
    const target = path.join(directory, name), next = JSON.stringify(data, null, 2) + '\n';
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== next) fs.writeFileSync(target, next);
  }
  for (const name of fs.readdirSync(directory)) if (!groups.has(name)) fs.unlinkSync(path.join(directory, name));
}

module.exports = { ROOT, moduleOfFile, walk, loadBaseline, writeBaseline };
