const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function pruneGuides(folder, live, report, now = Date.now()) {
  try {
    if (!fs.lstatSync(path.dirname(folder), { throwIfNoEntry: false })?.isDirectory()
      || !fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{32}\.md$/.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (live.has(file)) continue;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.mtimeMs >= now - MAX_AGE) continue;
        if (process.platform === 'win32') fs.chmodSync(file, 0o600);
        fs.unlinkSync(file);
      } catch (error) { if (error.code !== 'ENOENT') report(error); }
    }
  } catch (error) { if (error.code !== 'ENOENT') report(error); }
}

module.exports = { pruneGuides };
