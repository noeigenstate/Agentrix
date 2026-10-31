const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{32}(?:[a-f0-9]{32})?$/;
const SNAPSHOT = /^[a-f0-9]{64}-[a-f0-9]{32}(?:[a-f0-9]{32})?\.md(?:\.json)?$/;

function pruneDeliveryFiles(folder, live, report, now = Date.now()) {
  const cutoff = now - MAX_AGE;
  const visit = (directory, inspect) => {
    try {
      if (!fs.lstatSync(directory).isDirectory()) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) inspect(entry, path.join(directory, entry.name));
      }
    } catch (error) { if (error.code !== 'ENOENT') report(error); }
  };
  const expired = file => fs.statSync(file).mtimeMs < cutoff;
  visit(folder, (entry, file) => {
    if (entry.isFile() && SNAPSHOT.test(entry.name) && (!live.has(file.replace(/\.json$/, '')) || expired(file))) fs.unlinkSync(file);
  });
  // Only known receipt levels are traversed; never follow a symlink into another folder.
  visit(path.join(folder, 'receipts'), (provider, providerPath) => {
    if (!provider.isDirectory() || provider.name !== 'claude') return;
    visit(providerPath, (session, sessionPath) => {
      if (!session.isDirectory() || !HASH.test(session.name)) return;
      visit(sessionPath, (entry, file) => { if (entry.isFile() && HASH.test(entry.name) && expired(file)) fs.unlinkSync(file); });
      if (!fs.readdirSync(sessionPath).length) fs.rmdirSync(sessionPath);
    });
  });
}

module.exports = { pruneDeliveryFiles };
