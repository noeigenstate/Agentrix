const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('../../atomic-write.cjs');
const { validModel, EFFORT, familyOf } = require('../skills/seat-rules.mjs');
const { SEAT_BYTES } = require('../agents/call-seat.cjs');

// The file a terminal's shell integration and the dispatch helper read to reach main: the session's key, the event
// pipe and the control channel, and for a terminal also its hook channel and settings (hook-channel.cjs) and the paths
// its command hooks run. Only its owner can read it.
// Beside it, the session's own copy of the Claude Code start-up hook (claudeEnvFile, the planner's CLAUDE_ENV_FILE): Claude
// Code lets SessionStart hooks append to that file, so it is never the installed one.
const claudeEnvFile = file => file.replace(/\.json$/i, '') + '-claude-env.sh';

function updateBootstrapLead(file, lead) {
  if (lead && (!validModel(lead.model) || typeof lead.effort !== 'string' || !EFFORT.test(lead.effort))) throw new Error('Invalid lead seat.');
  const lines = lead ? [lead.model, lead.effort, lead.fast === true ? '1' : '0',
    JSON.stringify(lead.seatsMap ?? null), ...(lead.ultracode === true && familyOf(lead.model) === 'claude' ? ['ultracode'] : []), ''] : [];
  writeFileAtomic(file + '.lead', lines.join('\n'));
}

function writeSeatSnapshot(file, seats) {
  const snapshot = JSON.stringify(seats ?? null);
  const bounded = Buffer.byteLength(snapshot) <= SEAT_BYTES ? snapshot : 'null';
  for (let attempt = 0; ; attempt++) {
    try { writeFileAtomic(file, bounded); break; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
      // A command hook can briefly hold the old sidecar open on Windows.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 2 ** attempt);
    }
  }
  return bounded;
}

const updateDispatchSeats = (file, seats) => writeSeatSnapshot(file + '.seats', seats);
const updateDispatchLaunchSeats = (file, seats) => writeSeatSnapshot(file + '.launch-seats', seats);

function writeBootstrap({ file, eventServer, projectId, projectPath, sessionKey, controlAddress, controlCapability, lead, dispatchSeats, conductor = false, ...terminal }) {
  updateBootstrapMode(file, conductor);
  fs.rmSync(file + '.background.json', { force: true });
  const pipeName = process.platform === 'win32' ? eventServer.name : eventServer.address;
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'integration');
  const integration = terminal.claudeHookPath ? path.dirname(terminal.claudeHookPath)
    : packaged && fs.existsSync(path.join(packaged, 'shims', '.agentrix-shims')) ? packaged : path.resolve(__dirname, '../../../integration');
  const shims = path.join(integration, 'shims'), hook = path.join(shims, 'hooks/claude-env.sh');
  const copy = fs.existsSync(hook) ? claudeEnvFile(file) : undefined;
  if (copy) fs.writeFileSync(copy, fs.readFileSync(hook), { mode: 0o600 });
  fs.writeFileSync(file, JSON.stringify({ projectId, projectPath, sessionKey, controlAddress, controlCapability, pipeName,
    shims, nodePath: process.execPath, claudeEnvFile: copy, ...terminal }), { mode: 0o600 });
  if (lead !== undefined) updateBootstrapLead(file, lead);
  else fs.rmSync(file + '.lead', { force: true });
  try { fs.rmSync(file + '.launch-seats', { force: true }); } catch {}
  // Seat defaults are optional. A failed write should not leave an older launch's snapshot in use.
  if (dispatchSeats !== undefined) {
    try {
      const bounded = updateDispatchSeats(file, dispatchSeats);
      try { updateDispatchLaunchSeats(file, dispatchSeats); } catch {}
      return bounded;
    } catch {}
  }
  try { fs.rmSync(file + '.seats', { force: true }); } catch {}
}

// Writes the session's mode for its shims and role tools. True when it replaced the other mode: the owner switched.
function updateBootstrapMode(file, conductor) {
  const mode = conductor ? 'conductor\n' : 'native\n';
  let previous = null;
  try { previous = fs.readFileSync(file + '.mode', 'utf8'); } catch {}
  if (previous === mode) return false;
  writeFileAtomic(file + '.mode', mode);
  return previous !== null;
}

// Removes a session's bootstrap file and the files written with it.
function removeBootstrap(file) {
  for (const suffix of ['', '.background.json', '.lead', '.seats', '.launch-seats', '.mode']) fs.rmSync(file + suffix, { force: true });
  fs.rmSync(claudeEnvFile(file), { force: true });
}

// Refresh only launch policy: keys, hook settings and the private startup hook remain unchanged.
async function updateBootstrapBackground(file, allow, { rename = fs.renameSync,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Hooks can hold the bootstrap open on Windows. Launchers always re-read this independent policy, including after
  // the bounded bootstrap refresh fails. It contains no key and stays authoritative until the session is removed.
  fs.writeFileSync(file + '.background.json', JSON.stringify({ claudeBackgroundTasks: allow === true }), { mode: 0o600 });
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  data.claudeBackgroundTasks = allow === true;
  const temporary = file + '.' + randomUUID() + '.background.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (current.sessionKey !== data.sessionKey) throw Object.assign(new Error('The bootstrap session changed.'), { code: 'ESTALE' });
        rename(temporary, file); break;
      }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 4) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { writeBootstrap, removeBootstrap, updateBootstrapBackground, updateBootstrapLead, updateBootstrapMode, updateDispatchSeats, updateDispatchLaunchSeats };
