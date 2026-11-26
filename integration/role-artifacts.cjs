const fs = require('node:fs/promises');
const { existsSync, lstatSync, readFileSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const packaged = existsSync(path.join(__dirname, 'electron'));
const { isOwnedDirectory } = packaged
  ? require('./electron/session-files.cjs') : require('../electron/session-files.cjs');
const { readRoleResult } = packaged
  ? require('./electron/features/agents/dispatch-events.cjs') : require('../electron/features/agents/dispatch-events.cjs');

const PREFIX = 'agentrix-role-';
const NAME = /^agentrix-role-[A-Za-z0-9]{6}$/;
const MARKER = '.agentrix-role';
const RUN_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const ROLE_RESULT_SERVER = 'agentrix_role';
const RESULT_FILE = 'result.json';
const FORMAT = 'agentrix.role-result';
const ANSWER_BYTES = 200 * 1024;
const DAY = 86400000;
const RETENTION = 7 * DAY;
const ORPHAN_RETENTION = 30 * DAY;
const MAX_FOLDERS = 256;
const MAX_SCAN = 16384;
const MAX_REMOVALS = 32;
const RETRY_DELAY = 60000;
const failed = new Map();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const privateFolder = stat => isOwnedDirectory(stat, process.getuid?.(), process.getuid ? 0o022 : 0);

async function createRoleArtifacts(root = os.tmpdir()) {
  const folder = await fs.mkdtemp(path.join(await fs.realpath(root), PREFIX));
  const token = randomUUID();
  await fs.writeFile(path.join(folder, MARKER), token, { flag: 'wx', mode: 0o600 });
  return { folder, token };
}

async function readStamp(folder, name, limit) {
  const file = path.join(folder, name);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > limit) return null;
  const handle = await fs.open(file, 'r');
  try {
    if (!sameFile(stat, await handle.stat())) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer);
    return bytesRead === stat.size ? buffer.toString('utf8', 0, bytesRead) : null;
  } finally { await handle.close(); }
}

const string = { type: 'string' };
const list = (items, maxItems) => ({ type: 'array', items, ...(maxItems && { maxItems }) });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const finishRole = {
  name: 'finish_role',
  description: 'Save your final role answer and any decisions, approvals, findings and verification for the lead.',
  inputSchema: object({
    answer: { ...string, minLength: 1, maxLength: ANSWER_BYTES, description: 'Final Markdown answer, at most 200 KiB in UTF-8.' },
    needsDecision: list(object({ question: string, options: list(object({ label: string, effect: string })), recommendation: string })),
    needsApproval: list(object({ action: string, reason: string })),
    findings: list({ ...string, maxLength: 1000 }, 20),
    verification: object({
      ran: list(object({ command: string, result: { ...string, enum: ['pass', 'fail', 'skipped'] }, note: string })),
      unverified: list(string),
    }),
  }, ['answer']),
};

function validInput(value, schema) {
  if (schema.type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0)
    && (schema.maxLength === undefined || [...value].length <= schema.maxLength) && (!schema.enum || schema.enum.includes(value));
  if (schema.type === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? Infinity)
    && value.every(item => validInput(item, schema.items));
  return value !== null && typeof value === 'object' && !Array.isArray(value) && schema.required.every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, field]) => Object.hasOwn(schema.properties, key) && validInput(field, schema.properties[key]));
}

async function checkResultFolder(folder, runId) {
  if (!RUN_ID.test(runId) || typeof folder !== 'string' || !path.isAbsolute(folder) || !NAME.test(path.basename(folder))
    || !privateFolder(await fs.lstat(folder)) || path.relative(folder, await fs.realpath(folder))
    || !RUN_ID.test(await readStamp(folder, MARKER, 36))) throw new Error('Invalid role result directory or run ID');
}

function roleResultServer(dispatchPath, runId, folder) {
  return { command: process.execPath, args: [dispatchPath, 'mcp-role', runId, folder], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

async function readRoleResultFile(folder, runId) {
  const file = path.join(folder, RESULT_FILE);
  const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error('Unreadable role result');
  const handle = await fs.open(file, 'r');
  try {
    if (!sameFile(stat, await handle.stat())) throw new Error('Role result changed while opening');
    const result = readRoleResult(await handle.readFile('utf8'));
    if (result.runId !== runId) throw new Error('Role result belongs to a different run');
    return result;
  } finally { await handle.close(); }
}

async function writeRoleResult(folder, result) {
  const text = JSON.stringify(result) + '\n';
  readRoleResult(result);
  const temporary = path.join(folder, `.${RESULT_FILE}-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(text); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(folder, RESULT_FILE));
  } finally { await fs.rm(temporary, { force: true }); }
}

function createRoleResultTools({ folder, runId, now = Date.now }) {
  let tail = Promise.resolve();
  function finish_role(input) {
    const request = tail.then(async () => {
      if (!validInput(input, finishRole.inputSchema) || !input.answer.trim() || Buffer.byteLength(input.answer) > ANSWER_BYTES) {
        throw new Error('Invalid finish_role arguments: provide an answer up to 200 KiB in UTF-8 and use the listed field shapes and limits.');
      }
      await checkResultFolder(folder, runId);
      const previous = await readRoleResultFile(folder, runId);
      const calls = (previous?.calls ?? 0) + 1;
      await writeRoleResult(folder, { format: FORMAT, version: 1, runId, source: 'finish-role',
        needsDecision: [], needsApproval: [], findings: [], ...input, calls, at: now() });
      return { saved: true, calls };
    });
    tail = request.catch(() => {});
    return request;
  }
  return { list: () => [finishRole], tools: { finish_role } };
}

async function settleRoleResult({ folder, runId, answer, legacyDecision, now = Date.now }) {
  if (folder) {
    await checkResultFolder(folder, runId);
    const saved = await readRoleResultFile(folder, runId);
    if (saved?.source === 'finish-role') return saved;
  }
  const result = { format: FORMAT, version: 1, runId, source: legacyDecision?.(answer) ? 'legacy-heading' : 'final-text',
    answer, needsDecision: null, needsApproval: [], findings: [], calls: 0, at: now() };
  if (folder) await writeRoleResult(folder, result);
  return result;
}

const roleNeedsDecision = ({ source, needsDecision }) => source === 'legacy-heading' ? true : needsDecision === null ? null : needsDecision.length > 0;

function roleResultFields({ format, version, runId, ...result }) {
  return { ...result, ...(result.source !== 'finish-role' && { notice: '未调用 finish_role' }),
    ...(result.source === 'legacy-heading' && { legacyNeedsDecision: true }) };
}

async function stampRoleArtifacts({ folder, token }, state, now = Date.now()) {
  try {
    if (!NAME.test(path.basename(folder)) || !privateFolder(await fs.lstat(folder)) || await readStamp(folder, MARKER, 36) !== token) return;
    const value = state === 'ended' ? `${token}:${now}` : token;
    await fs.writeFile(path.join(folder, `${MARKER}-${state}`), value, { flag: 'wx', mode: 0o600 });
  } catch { /* Artifact bookkeeping must not change a role's result. */ }
}

function trackRoleProcess({ folder, token }, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (!NAME.test(path.basename(folder)) || !privateFolder(lstatSync(folder))) throw new Error('Unsafe role artifact directory');
  const marker = path.join(folder, MARKER), stat = lstatSync(marker);
  if (!stat.isFile() || stat.size !== 36 || readFileSync(marker, 'utf8') !== token) throw new Error('Invalid role artifact marker');
  try { writeFileSync(path.join(folder, `${MARKER}-pid-${pid}`), token, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function orphaned(folder, token, now) {
  const marker = await fs.lstat(path.join(folder, MARKER));
  if (now - marker.mtimeMs < ORPHAN_RETENTION) return false;
  for await (const entry of await fs.opendir(folder)) {
    const pid = Number(/^\.agentrix-role-pid-([1-9]\d*)$/.exec(entry.name)?.[1]);
    if (!Number.isSafeInteger(pid) || await readStamp(folder, entry.name, 36) !== token) continue;
    try { process.kill(pid, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return true;
}

async function inspectRole(folder, now) {
  const identity = await fs.lstat(folder);
  if (!privateFolder(identity) || await fs.realpath(folder) !== folder) return null;
  const token = await readStamp(folder, MARKER, 36);
  if (!token || !RUN_ID.test(token)) return null;
  const stamp = await readStamp(folder, MARKER + '-ended', 53);
  const ended = stamp?.startsWith(token + ':') ? Number(stamp.slice(37)) : null;
  const settled = Number.isSafeInteger(ended) && ended > 0 && ended <= now;
  const read = settled && await readStamp(folder, MARKER + '-read', 36) === token;
  return { folder, identity, ended: settled ? ended : null, read, orphan: !settled && await orphaned(folder, token, now) };
}

async function sweepRoleArtifacts(root, { now = Date.now(), maxFolders = MAX_FOLDERS, remove = fs.rm, onRemoved = () => {} } = {}) {
  try {
    for (const [folder, retryAt] of failed) if (retryAt <= now) failed.delete(folder);
    const parent = await fs.realpath(root);
    const roles = [];
    let scanned = 0;
    for await (const entry of await fs.opendir(parent)) {
      if (++scanned > MAX_SCAN) break;
      if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
      const role = await inspectRole(path.join(parent, entry.name), now).catch(() => null);
      if (role) roles.push(role);
    }
    let excess = roles.length - maxFolders, removed = 0;
    roles.sort((a, b) => (a.ended ?? Infinity) - (b.ended ?? Infinity));
    for (const { folder, identity, ended, read, orphan } of roles) {
      if (removed >= MAX_REMOVALS) break;
      const days = orphan ? 30 : ended !== null && now - ended >= RETENTION ? 7 : null;
      if (failed.has(folder) || !(days || read && excess > 0)) continue;
      try {
        if (await fs.realpath(folder) !== folder) continue;
        const names = await fs.readdir(folder);
        if (orphan && !(await inspectRole(folder, now))?.orphan) continue;
        const current = await fs.lstat(folder);
        if (!privateFolder(current) || !sameFile(identity, current)) continue;
        // Retain the ownership and settlement stamps if deleting a locked artifact fails.
        for (const name of names) {
          if (name === MARKER || name.startsWith(MARKER + '-')) continue;
          await remove(path.join(folder, name), { recursive: true, force: true });
        }
        const final = await fs.lstat(folder);
        if (!privateFolder(final) || !sameFile(identity, final)) continue;
        await fs.rm(folder, { recursive: true });
        excess--;
        removed++;
        onRemoved(folder, days);
      } catch { failed.set(folder, now + RETRY_DELAY); }
    }
  } catch { /* A missing or unreadable temp root does not block MCP. */ }
}

module.exports = { createRoleArtifacts, stampRoleArtifacts, trackRoleProcess, sweepRoleArtifacts, RETENTION, ORPHAN_RETENTION,
  ROLE_RESULT_SERVER, roleResultServer, createRoleResultTools, readRoleResultFile, settleRoleResult, roleNeedsDecision, roleResultFields };
