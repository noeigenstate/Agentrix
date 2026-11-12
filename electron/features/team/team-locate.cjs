// Main's team lookup: Git runs off the event loop. The helper keeps team.cjs's synchronous projectTeam.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile: nodeExecFile } = require('node:child_process');
const { teamAt } = require('./team.cjs');

const COMMON_DIR_TTL_MS = 30000;

// Only Git's common directory is remembered, by the directory's real path for 30 s. Whether the team folder exists is
// checked on every lookup, so a team the helper has just created is found at once; a failed lookup is never kept.
// execFile has node:child_process's signature, so a test can delay or fail Git.
function createTeamLocator({ execFile = nodeExecFile, now = Date.now } = {}) {
  const commons = new Map();
  const commonOf = cwd => new Promise(resolve => execFile('git', ['rev-parse', '--git-common-dir'],
    { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout) => resolve(error ? null : path.resolve(cwd, String(stdout).trim()))));
  return async function locateTeam(cwd) {
    let real;
    try { real = await fs.realpath(cwd); } catch { return null; }
    let cached = commons.get(real);
    if (!cached || now() - cached.at >= COMMON_DIR_TTL_MS) commons.set(real, cached = { at: now(), common: commonOf(cwd) });
    const common = await cached.common;
    if (!common) {
      if (commons.get(real) === cached) commons.delete(real);
      return null;
    }
    try { return teamAt(common, cwd); } catch { return null; }
  };
}

const locateTeam = createTeamLocator();

module.exports = { locateTeam, createTeamLocator, COMMON_DIR_TTL_MS };
