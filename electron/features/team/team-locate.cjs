// Main's team lookup: Git runs off the event loop. The helper keeps team.cjs's synchronous projectTeam.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile: nodeExecFile } = require('node:child_process');
const { teamAt } = require('./team.cjs');

const COMMON_DIR_TTL_MS = 30000, GIT_TIMEOUT_MS = 10000;

// Only Git's common directory is remembered, by the directory's real path for 30 s. Whether the team folder exists is
// checked on every lookup, so a team the helper has just created is found at once; unsuccessful Git lookups are never kept.
// Registration asks for details; existing readers still get the team or null from this same lookup.
// execFile has node:child_process's signature, so a test can delay or fail Git.
function createTeamLocator({ execFile = nodeExecFile, now = Date.now } = {}) {
  const commons = new Map();
  const commonOf = cwd => new Promise(resolve => execFile('git', ['rev-parse', '--git-common-dir'],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
      if (error) {
        const outside = error.code === 128 && !error.killed && !error.signal
          && /^fatal: not a git repository \(or any of the parent directories\): \.git(?:\r?\n|$)/.test(String(stderr || ''));
        resolve({ status: outside ? 'outside_git' : 'git_error', common: null }); return;
      }
      const directory = String(stdout || '').trim();
      if (!directory) { resolve({ status: 'git_error', common: null }); return; }
      fs.realpath(path.resolve(cwd, directory)).then(common => resolve({ status: 'found', common }),
        () => resolve({ status: 'git_error', common: null }));
    }));
  async function lookup(cwd, details) {
    let real;
    try { real = await fs.realpath(cwd); } catch { return { status: 'git_error', common: null, team: null }; }
    let cached = commons.get(real);
    if (!cached || now() - cached.at >= COMMON_DIR_TTL_MS) commons.set(real, cached = { at: now(), common: commonOf(cwd) });
    const { status, common } = await cached.common.catch(() => ({ status: 'git_error', common: null }));
    if (!common) {
      if (commons.get(real) === cached) commons.delete(real);
      return { status, common: null, team: null };
    }
    try {
      const team = teamAt(common, cwd);
      if (details && team && !(await fs.stat(team.board)).isDirectory()) return { status: 'no_team', common, team: null };
      return { status: team ? 'found' : 'no_team', common, team };
    } catch (error) { return { status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'no_team' : 'git_error', common, team: null }; }
  }
  return async function locateTeam(cwd, { details = false } = {}) {
    const result = await lookup(cwd, details);
    return details ? result : result.team;
  };
}

const locateTeam = createTeamLocator();

module.exports = { locateTeam, createTeamLocator };
