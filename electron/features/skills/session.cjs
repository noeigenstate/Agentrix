// Shared with the plain-Node shell hook and dispatch runtime. No Electron or account files.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const MARKER = / Agentrix skill delivery: ([a-f0-9]{64}):([A-Za-z0-9_-]+)\./;
const MAX_MANIFEST = 2 * 1024 * 1024;
// Receipt names keep 128 bits of each digest: the full pair made paths past Windows PowerShell's 260-character limit.
const RECEIPT = 32;

function deliveryMarker(delivery) {
  if (delivery.remote) return 'Agentrix skill delivery: remote. ';
  return delivery.fingerprint
    ? `Agentrix skill delivery: ${delivery.fingerprint}:${Buffer.from(delivery.sessionManifest || delivery.manifest).toString('base64url')}. ` : '';
}

function readDelivery(note) {
  const match = MARKER.exec(note || '');
  if (!match) return null;
  const manifest = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!path.isAbsolute(manifest) || fs.lstatSync(manifest).isSymbolicLink() || fs.statSync(manifest).size > MAX_MANIFEST) return null;
  const instructions = fs.readFileSync(manifest, 'utf8');
  return { manifest, fingerprint: match[1], instructions, context: `Agentrix skill instructions:\n${instructions}` };
}

function receiptPath(delivery, sessionId) {
  if (!/^[\w-]{1,160}$/.test(sessionId || '')) throw new Error('Invalid skill delivery session');
  const parent = path.join(path.dirname(delivery.manifest), 'receipts');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(parent).isSymbolicLink()) throw new Error('Invalid skill receipt folder');
  const providerFolder = path.join(parent, 'claude');
  fs.mkdirSync(providerFolder, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(providerFolder).isSymbolicLink()) throw new Error('Invalid skill receipt folder');
  const folder = path.join(providerFolder, digest(sessionId).slice(0, RECEIPT));
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(folder).isSymbolicLink()) throw new Error('Invalid skill receipt folder');
  const receipt = path.join(folder, delivery.fingerprint.slice(0, RECEIPT));
  try { if (fs.lstatSync(receipt).isSymbolicLink()) throw new Error('Invalid skill receipt'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return receipt;
}

function forgetReceipts(receipt) {
  const folder = path.dirname(receipt);
  for (const file of fs.readdirSync(folder)) if (/^[a-f0-9]{32}$/.test(file)) fs.rmSync(path.join(folder, file), { force: true });
}

function sessionContext(hook, note) {
  if (!/^[\w-]{1,160}$/.test(hook?.session_id || '') || !['startup', 'resume', 'compact', 'clear'].includes(hook.source)) return null;
  const delivery = readDelivery(note);
  if (!delivery) return null;
  const receipt = receiptPath(delivery, hook.session_id);
  const force = hook.source === 'compact' || hook.source === 'clear';
  if (force) forgetReceipts(receipt);
  try { fs.closeSync(fs.openSync(receipt, force ? 'w' : 'wx', 0o600)); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: delivery.context } };
}

module.exports = { digest, deliveryMarker, readDelivery, sessionContext };
