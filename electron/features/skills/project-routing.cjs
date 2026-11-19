const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { familyOf, rankByName } = require('./seat-rules.mjs');
const { cleanConfig, resolveTeam, validateTeam } = require('./team-roles.cjs');
const operationSlots = require('./operation-slots.cjs');

const ROUTING_PATH = '.agentrix/routing.json';
const MAX_BYTES = 32 * 1024;
const FORMAT = 'agentrix-routing';
const hash = (...parts) => {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part);
  return digest.digest('hex');
};
const invalid = (code, digest, raw) => ({ digest, raw, error: { code, message: code } });
const refusal = code => ({ ok: false, code, message: code });

function canonicalJSON(document) {
  const chunks = [], pending = [{ value: document, depth: 0 }];
  let tooDeep = false, unsafe = false;
  while (pending.length) {
    const token = pending.pop();
    if (typeof token === 'string') { chunks.push(token); continue; }
    const { value, depth } = token;
    if (!value || typeof value !== 'object') { chunks.push(JSON.stringify(value)); continue; }
    if (depth >= 4) tooDeep = true;
    const array = Array.isArray(value), keys = Object.keys(value);
    if (!array) keys.sort();
    chunks.push(array ? '[' : '{');
    pending.push(array ? ']' : '}');
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key === '__proto__' || key === 'constructor') unsafe = true;
      pending.push({ value: value[key], depth: depth + 1 });
      if (!array) pending.push(JSON.stringify(key) + ':');
      if (index) pending.push(',');
    }
  }
  return { json: chunks.join(''), tooDeep, unsafe };
}

function parseRouting(bytes, entry, catalog, defaults) {
  let raw, document;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid('bad-utf8', hash('raw\0', bytes)); }
  try { document = JSON.parse(raw); }
  catch { return invalid('bad-json', hash('raw\0', bytes), raw); }
  const { json, tooDeep, unsafe } = canonicalJSON(document), digest = hash('agentrix-routing-v1\n', json);
  if (unsafe) return invalid('unknown-key', digest, raw);
  if (tooDeep) return invalid('too-deep', digest, raw);
  if (document?.format !== FORMAT) return invalid('bad-format', digest, raw);
  if (Number.isInteger(document.version) && document.version > 1) return invalid('newer-version', digest, raw);
  if (document.version !== 1) return invalid('bad-format', digest, raw);
  const { format, version, ...body } = document;
  try {
    const { config, ignored } = cleanConfig(body, entry, catalog, true), team = resolveTeam(entry, config, defaults);
    const error = validateTeam(team, config, catalog);
    return error ? invalid(error.code, digest, raw) : { digest, raw, config, ignored };
  } catch (error) {
    return invalid(error.code || 'bad-format', digest, raw);
  }
}

const stat = file => fs.lstatSync(file, { throwIfNoEntry: false });
const sameNode = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;
const nodeError = (code, info) => invalid(code, hash('link\0', [code, info?.mode, info?.size, info?.mtimeMs].join(':')));

function locate(root) {
  const folder = path.resolve(root, '.agentrix'), parents = [];
  for (let directory = folder; ; directory = path.dirname(directory)) {
    parents.push(directory);
    if (directory === path.dirname(directory)) break;
  }
  let dir;
  for (const parent of parents.reverse()) {
    dir = stat(parent);
    const watch = parent === folder ? path.dirname(folder) : null;
    if (!dir) return { folder, watch };
    if (dir.isSymbolicLink()) return { watch, error: nodeError('link', dir) };
    if (!dir.isDirectory()) return { watch, error: nodeError('not-file', dir) };
  }
  const file = path.join(folder, 'routing.json'), info = stat(file);
  if (info?.isSymbolicLink()) return { folder, dir, error: nodeError('link', info) };
  if (info && !info.isFile()) return { folder, dir, error: nodeError('not-file', info) };
  return { folder, file, info, dir };
}

function routingWatch(root) {
  try {
    const target = locate(root), info = target.info;
    return { folder: target.dir ? target.folder : target.watch ?? null,
      signature: target.error?.digest ?? (info ? [info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') : '') };
  } catch {
    return { folder: null, signature: 'unreadable' };
  }
}

function readRouting(root, entry, catalog, defaults) {
  let handle;
  try {
    const target = locate(root);
    if (target.error) return target.error;
    if (!target.info) return { digest: null };
    handle = fs.openSync(target.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(handle), current = locate(root);
    if (!opened.isFile() || current.error || !sameNode(opened, current.info) || !sameNode(target.dir, current.dir)) {
      return current.error || nodeError('not-file', opened);
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(handle, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length), after = fs.fstatSync(handle);
    if (length > MAX_BYTES || after.size > MAX_BYTES) return invalid('too-large', hash('big\0', after.size + ':' + after.mtimeMs + ':', bytes));
    return parseRouting(bytes, entry, catalog, defaults);
  } catch (error) {
    return error.code === 'ELOOP' ? nodeError('link') : nodeError('not-file');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function serializeRouting(config) {
  return JSON.stringify({ format: FORMAT, version: 1, roles: config.roles, operations: config.operations }, null, 2) + '\n';
}

function writeRouting(root, config, base, context, beforeRename) {
  const read = () => readRouting(root, ...context);
  const text = serializeRouting(config), bytes = Buffer.from(text);
  if (bytes.length > MAX_BYTES) return refusal('file-unwritable');
  const { digest, error } = parseRouting(bytes, ...context);
  if (error) return refusal('file-unwritable');
  let target, temporary, rollback;
  try {
    if (read().digest !== base) return refusal('file-changed');
    target = locate(root);
    if (target.error) return refusal('file-unwritable');
    if (!target.dir) {
      try { fs.mkdirSync(target.folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      target = locate(root);
      if (!target.dir || target.error) return refusal('file-unwritable');
    }
    temporary = path.join(target.folder, '.routing-' + randomUUID() + '.tmp');
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    if (read().digest !== base) return refusal('file-changed');
    rollback = beforeRename(digest);
    if (read().digest !== base) { rollback(); return refusal('file-changed'); }
    const current = locate(root);
    if (current.error || !sameNode(target.dir, current.dir)) throw new Error('Routing directory changed.');
    fs.renameSync(temporary, target.file);
    return { ok: true };
  } catch {
    rollback?.();
    return refusal('file-unwritable');
  } finally {
    if (temporary) {
      try { if (sameNode(stat(target.folder), target.dir)) fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}

function reviewFile(file, reason, team, previous, catalog) {
  const { config, digest, ignored } = file, changes = [], flags = [];
  const flag = (code, key, id, text) => flags.push({ code, [key]: id, text });
  const rank = model => catalog.find(row => row.model === model)?.rank ?? rankByName(model);
  const listed = model => catalog.some(row => row.model === model && row.listed !== false);
  const diff = (key, id, field, from, to) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ [key]: id, field, from, to });
  };
  const oldRoles = new Map(previous.team.map(item => [item.row.id, item]));
  const nextRoles = new Map(team.team.map(item => [item.row.id, item]));
  for (const id of new Set([...oldRoles.keys(), ...nextRoles.keys()])) {
    const before = oldRoles.get(id), after = nextRoles.get(id), role = after?.row, old = before?.row, seat = after?.seat;
    for (const field of ['enabled', 'name', 'duty', 'outputs', 'fresh', 'from']) diff('role', id, field, old?.[field], role?.[field]);
    for (const field of ['model', 'effort', 'fast']) diff('role', id, field, before?.seat?.[field], seat?.[field]);
    if (role?.source === 'custom') flag('custom-text', 'role', id, [role.duty, role.outputs].filter(Boolean).join(' / '));
    if (['qa', 'security', 'a11y'].includes(id) && (old?.enabled && !role?.enabled || old?.fresh && !role?.fresh && role?.enabled)) {
      flag('verification-weakened', 'role', id, role?.name || id);
    }
    if (!role?.enabled || !seat) continue;
    const modelChanged = !old?.enabled || before.seat?.model !== seat.model;
    if (modelChanged && rank(seat.model) === 3) flag('expensive-model', 'role', id, seat.model);
    if (modelChanged && !listed(seat.model)) flag('unlisted-model', 'role', id, seat.model);
    if (seat.fast && (!old?.enabled || !before.seat?.fast)) flag('fast-on', 'role', id, seat.model);
    if (['xhigh', 'max'].includes(seat.effort) && (!old?.enabled || before.seat?.effort !== seat.effort)) flag('high-effort', 'role', id, seat.effort);
  }
  const nextOps = operationSlots.resolve(config.operations);
  for (const [id, value] of Object.entries(nextOps)) {
    const old = previous.operations[id];
    diff('operation', id, 'value', old, value);
    if (typeof value === 'string' || old?.model === value.model && old?.effort === value.effort) continue;
    if (!listed(value.model)) flag('unlisted-model', 'operation', id, value.model);
    if (['lookup', 'background'].includes(id) && familyOf(value.model) === 'claude' && rank(value.model) === 3) flag('operation-cost', 'operation', id, value.model);
    if (['xhigh', 'max'].includes(value.effort) && old?.effort !== value.effort) flag('high-effort', 'operation', id, value.effort);
  }
  return { digest, reason, config, changes, flags, ignored };
}

function routingState(project, file, stored, seen = false) {
  const id = project?.id, remote = project?.kind === 'ssh';
  const local = id && Object.hasOwn(stored.local || {}, id) ? stored.local[id] : null;
  const trust = id && Object.hasOwn(stored.trust || {}, id) ? stored.trust[id] : null;
  const source = { layer: local ? 'local' : 'template', state: 'absent', remote, path: project && !remote ? ROUTING_PATH : null, digest: file.digest, actions: [] };
  if (!file.digest) {
    if (!remote && (trust || seen)) source.notice = 'file-deleted';
    return { source, config: local };
  }
  if (file.config && trust?.digest === file.digest) {
    return { source: { ...source, layer: 'file', state: 'trusted' }, config: file.config };
  }
  const rejected = trust?.rejected === file.digest;
  source.state = rejected ? 'rejected' : file.error ? 'invalid' : 'pending';
  if (file.error) source.error = file.error;
  if (file.raw !== undefined) source.raw = file.raw;
  if (file.config) source.actions.push('apply');
  if (!rejected) source.actions.push('keep');
  if (!['link', 'not-file'].includes(file.error?.code)) source.actions.push('overwrite');
  if (trust?.config) source.layer = 'accepted';
  return { source, config: trust?.config ?? local, reason: trust?.digest || trust?.rejected ? 'changed' : 'new-on-machine' };
}

module.exports = { MAX_BYTES, ROUTING_PATH, readRouting, writeRouting, routingState, reviewFile, routingWatch };
