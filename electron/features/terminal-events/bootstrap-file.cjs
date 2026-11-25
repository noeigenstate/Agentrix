const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('../../atomic-write.cjs');
const { validModel, EFFORT, familyOf } = require('../skills/seat-rules.mjs');
const { SEAT_BYTES, writeSeatMap } = require('../agents/call-seat.cjs');
const { readEnvelope, writeKeyValue } = require('../agents/dispatch-events.cjs');

const BOOTSTRAP_FORMAT = 'agentrix.bootstrap';
const BACKGROUND_FORMAT = 'agentrix.background-policy';

// The file a terminal's shell integration and the dispatch helper read to reach main: the session's key, the event
// pipe and the control channel, and for a terminal also its hook channel and settings (hook-channel.cjs) and the paths
// its command hooks run. Only its owner can read it.
// Beside it, the session's own copy of the Claude Code start-up hook (claudeEnvFile, the planner's CLAUDE_ENV_FILE): Claude
// Code lets SessionStart hooks append to that file, so it is never the installed one.
const claudeEnvFile = file => file.replace(/\.json$/i, '') + '-claude-env.sh';

function updateBootstrapLead(file, lead) {
  if (lead && (!validModel(lead.model) || typeof lead.effort !== 'string' || !EFFORT.test(lead.effort))) throw new Error('Invalid lead seat.');
  const seats = JSON.stringify(lead?.seatsMap ?? null);
  const bounded = Buffer.byteLength(seats) <= SEAT_BYTES ? seats : 'null';
  const fast = lead?.fast === true ? '1' : '0';
  const ultra = lead?.ultracode === true && familyOf(lead.model) === 'claude';
  const next = lead && writeKeyValue({ format: 'agentrix.lead-seat', version: '1', model: lead.model, effort: lead.effort,
    fast, ultracode: ultra ? '1' : '0', seats: bounded });
  const legacy = lead ? [lead.model, lead.effort, fast, bounded, ...(ultra ? ['ultracode'] : []), ''].join('\n') : '';
  writeFileAtomic(file + '.lead', legacy);
  if (next) writeFileAtomic(file + '.lead.env', next);
  else fs.rmSync(file + '.lead.env', { force: true });
}

function writeSeatSnapshot(file, seats) {
  const snapshot = writeSeatMap(seats);
  const bounded = Buffer.byteLength(snapshot) <= SEAT_BYTES ? snapshot : writeSeatMap(null);
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
    shims, nodePath: process.execPath, claudeEnvFile: copy, ...terminal, format: BOOTSTRAP_FORMAT, version: 1 }), { mode: 0o600 });
  if (lead !== undefined) updateBootstrapLead(file, lead);
  else for (const suffix of ['.lead', '.lead.env']) fs.rmSync(file + suffix, { force: true });
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
  const mode = conductor ? 'conductor' : 'native', legacy = mode + '\n';
  const next = writeKeyValue({ format: 'agentrix.session-mode', version: '1', mode });
  const previous = readOptionalText(file + '.mode');
  if (readOptionalText(file + '.mode.env') !== next) writeFileAtomic(file + '.mode.env', next);
  if (previous !== legacy) writeFileAtomic(file + '.mode', legacy);
  return previous !== undefined && previous !== legacy;
}

function readOptionalText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

// Removes a session's bootstrap file and the files written with it.
function removeBootstrap(file) {
  const suffixes = ['', '.background.json', '.lead', '.lead.env', '.seats', '.launch-seats', '.mode', '.mode.env', '.launch-note'];
  for (const suffix of suffixes) fs.rmSync(file + suffix, { force: true });
  fs.rmSync(claudeEnvFile(file), { force: true });
}

const readBootstrap = file => readEnvelope(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), { format: BOOTSTRAP_FORMAT }).value;

// Refresh only launch policy: keys, hook settings and the private startup hook remain unchanged.
async function updateBootstrapBackground(file, allow, { rename = fs.renameSync,
  delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Hooks can hold the bootstrap open on Windows. Launchers always re-read this independent policy, including after
  // the bounded bootstrap refresh fails. It contains no key and stays authoritative until the session is removed.
  const policy = { format: BACKGROUND_FORMAT, version: 1, claudeBackgroundTasks: allow === true };
  fs.writeFileSync(file + '.background.json', JSON.stringify(policy), { mode: 0o600 });
  const data = readBootstrap(file);
  data.claudeBackgroundTasks = allow === true;
  const temporary = file + '.' + randomUUID() + '.background.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        const current = readBootstrap(file);
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
