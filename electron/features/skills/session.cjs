// Shared with the plain-Node shell hook and dispatch runtime. No Electron or account files.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const MARKER = / Agentrix skill delivery: ([a-f0-9]{64}):([A-Za-z0-9_-]+)\./;
const MAX_MANIFEST = 2 * 1024 * 1024;
// Receipt names keep 128 bits of each digest: the full pair made paths past Windows PowerShell's 260-character limit.
const RECEIPT = 32;
const MAX_BYTES = 512 * 1024;

// The library and the carried worker guard decode the same skill names and metadata.
function frontMatter(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES || text.includes('\0')) throw new Error('技能文件过大或格式无效。');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const [, key, raw] of match[1].matchAll(/^([\w-]+):[ \t]*(.*(?:\r?\n[ \t]+.*)*)$/gm)) {
    if (Object.hasOwn(fields, key)) continue;
    let value = raw.trim();
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    fields[key] = value;
  }
  return { fields, raw: match[1], body: text.slice(match[0].length) };
}

// Also used by the carried, plain-Node worker guard, which cannot import the library store.
function assertUserSkillName(name, builtinNames) {
  if (builtinNames.includes(name)) throw new Error(`与系统技能「${name}」同名。要扩展它，请命名为 ${name}-<标识>，例如 ${name}-team。`);
}

function currentDelivery(delivery) {
  try {
    const file = `${delivery.manifest}.json`;
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > MAX_MANIFEST) return delivery;
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    const current = metadata.current;
    if (metadata.fingerprint !== delivery.fingerprint || typeof current !== 'string' || !path.isAbsolute(current)
      || path.dirname(current) !== path.dirname(delivery.manifest) || fs.lstatSync(current).isSymbolicLink()
      || fs.statSync(current).size > MAX_MANIFEST) return delivery;
    const instructions = fs.readFileSync(current, 'utf8');
    return { ...delivery, instructions, context: `Agentrix skill instructions:\n${instructions}` };
  } catch { return delivery; }
}

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
  return path.join(folder, delivery.fingerprint.slice(0, RECEIPT));
}

function forgetReceipts(receipt) {
  const folder = path.dirname(receipt);
  for (const file of fs.readdirSync(folder)) if (/^[a-f0-9]{32}$/.test(file)) fs.rmSync(path.join(folder, file), { force: true });
}

function clearDeadClaim(lock) {
  try {
    if (!fs.lstatSync(lock).isDirectory()) return;
    const [owner] = fs.readdirSync(lock);
    if (owner) {
      const pid = /^(\d+)-[\da-f-]{36}$/.exec(owner)?.[1];
      if (!pid) return;
      try { process.kill(Number(pid), 0); return; }
      catch (error) { if (error.code !== 'ESRCH') return; }
      fs.unlinkSync(path.join(lock, owner));
    }
    fs.rmdirSync(lock);
  } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

function claimReceipt(receipt) {
  const lock = `${receipt}.node-pending`, owner = `${process.pid}-${randomUUID()}`;
  const temporary = fs.mkdtempSync(path.join(path.dirname(receipt), '.node-pending-'));
  try {
    fs.writeFileSync(path.join(temporary, owner), '', { flag: 'wx' });
    clearDeadClaim(lock);
    // An atomic rename installs a populated lock directory. Competing hooks cannot replace it.
    try { fs.renameSync(temporary, lock); }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM', 'EACCES'].includes(error.code) && fs.existsSync(lock)) return null;
      throw error;
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return () => { fs.unlinkSync(path.join(lock, owner)); clearDeadClaim(lock); };
}

async function sessionContext(hook, note, write) {
  if (!/^[\w-]{1,160}$/.test(hook?.session_id || '') || !['startup', 'resume', 'compact', 'clear'].includes(hook.source)) return null;
  let delivery = readDelivery(note);
  if (!delivery) return null;
  const receipt = receiptPath(delivery, hook.session_id);
  const force = hook.source === 'compact' || hook.source === 'clear';
  if (force) delivery = currentDelivery(delivery);
  const release = claimReceipt(receipt);
  if (!release) return null;
  try {
    const existing = fs.lstatSync(receipt, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new Error('Invalid skill receipt');
    if (existing && !force) return null;
    const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: delivery.context } };
    if (force) forgetReceipts(receipt);
    await write(output);
    try { fs.closeSync(fs.openSync(receipt, force ? 'w' : 'wx', 0o600)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return output;
  } finally { release(); }
}

module.exports = { digest, deliveryMarker, readDelivery, sessionContext, assertUserSkillName, skillFrontMatter: { MAX_BYTES, frontMatter } };
