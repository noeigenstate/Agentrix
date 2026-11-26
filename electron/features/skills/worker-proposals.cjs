// A dispatched worker can propose a skill edit; only a literal --allow path approves applying it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { repoFiles } = require('../../boundaries.cjs');
const { readDelivery, assertUserSkillName, skillFrontMatter: { frontMatter } } = require('./session.cjs');

const skillFile = file => path.basename(file).toLowerCase() === 'skill.md';
const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };
const within = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
const RETAIN_RUNS = 20;
const PREVIEW_BYTES = 2048;
const RECEIPT_BYTES = 512 * 1024;
const ARCHIVE_NAME = /^\d{13}-([a-f\d]{32})-[A-Za-z0-9]{6}$/;
const archiveId = id => createHash('sha256').update(id).digest('hex').slice(0, 32);

function commonDir(cwd) {
  try {
    return canonical(fs.realpathSync.native(path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim())));
  } catch { return null; }
}

function worktreeRoots(cwd) {
  try {
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const root = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']));
    const main = fs.realpathSync.native(git(['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length));
    return { root, main };
  } catch { return {}; }
}

function fileHash(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  try { for (let count; (count = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function managedDelivery(cwd, env) {
  try {
    const note = env.AGENTRIX_READING_NOTE_FILE ? fs.readFileSync(env.AGENTRIX_READING_NOTE_FILE, 'utf8') : env.AGENTRIX_READING_NOTE;
    const delivery = readDelivery(note);
    if (!delivery) return {};
    const metadata = JSON.parse(fs.readFileSync(`${delivery.manifest}.json`, 'utf8'));
    if (metadata.fingerprint !== delivery.fingerprint || typeof metadata.projectRoot !== 'string') return {};
    // An inherited startup note for a different project must never make a test or unrelated worker read its skills.
    const sameRepo = commonDir(cwd), projectRepo = commonDir(metadata.projectRoot);
    if (!within(metadata.projectRoot, cwd) && (!sameRepo || sameRepo !== projectRepo)) return {};
    if (!Array.isArray(metadata.roots) || metadata.roots.length > 32 || !metadata.roots.every(root => typeof root === 'string' && path.isAbsolute(root))) return {};
    const folder = path.dirname(fs.realpathSync.native(delivery.manifest));
    return { ...metadata, dataDir: path.basename(folder) === 'skill-delivery' ? path.dirname(folder) : null };
  } catch { return {}; }
}

function noLinks(root, file) {
  if (!within(root, file)) throw new Error('Skill path escaped its declared root');
  for (let current = file; ; current = path.dirname(current)) {
    if (exists(current)?.isSymbolicLink()) throw new Error('Refusing a symlink in a skill path');
    if (canonical(current) === canonical(root)) return;
  }
}

function archiveLocations(env, delivery, cwd, root) {
  const project = commonDir(cwd) || canonical(fs.realpathSync.native(delivery.projectRoot || root));
  const key = createHash('sha256').update(project).digest('hex');
  const remote = env.AGENTRIX_REMOTE_ROLE_TOOLS === '1';
  // Native role MCP receives the bootstrap path even when the provider strips the skill note and profile environment.
  const runtime = path.dirname(env.AGENTRIX_BOOTSTRAP || '');
  const bootstrapProfile = path.isAbsolute(runtime) && /^runtime-[A-Za-z0-9]{6}$/.test(path.basename(runtime)) ? path.dirname(runtime) : null;
  const profiles = remote ? [] : [delivery.dataDir, env.AGENTRIX_DATA_DIR, bootstrapProfile];
  const home = env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] || os.homedir();
  const account = process.getuid?.() ?? createHash('sha256').update(home).digest('hex').slice(0, 16);
  const temp = path.join(os.tmpdir(), `agentrix-skill-archive-${account}`);
  const bases = [...new Set([...profiles, path.join(home, '.agentrix'), temp])].filter(base => base && path.isAbsolute(base));
  return { bases, key, account, temp };
}

function archiveProject(env, delivery, cwd, root, main) {
  const real = fs.realpathSync.native;
  const { bases, key, account, temp } = archiveLocations(env, delivery, cwd, root);
  const prohibited = [root, cwd, main, delivery.projectRoot].filter(Boolean).map(file => canonical(real(file)));
  for (const base of bases) {
    try {
      const folders = [base, path.join(base, 'skill-proposals'), path.join(base, 'skill-proposals', key)];
      for (const folder of folders) {
        const stat = exists(folder);
        if (stat && !stat.isDirectory()) throw new Error('Unsafe skill proposal archive');
        const target = canonical(stat ? real(folder) : path.join(real(path.dirname(folder)), path.basename(folder)));
        if (prohibited.some(projectRoot => within(projectRoot, target))) throw new Error('Skill proposal archive is inside the project');
        if (!stat) {
          try { fs.mkdirSync(folder, { mode: 0o700 }); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const saved = fs.lstatSync(folder);
        if (!saved.isDirectory() || (folder !== base || base === temp) && process.getuid && (saved.uid !== account || saved.mode & 0o077)) {
          throw new Error('Unsafe skill proposal archive');
        }
      }
      return real(folders.at(-1));
    } catch { /* Try the next storage location. */ }
  }
  throw new Error('No writable skill proposal archive outside the project');
}

function findSkillProposalIndex(cwd, env, id) {
  try {
    const { bases, key } = archiveLocations(env, managedDelivery(cwd, env), cwd, cwd);
    const run = archiveId(id);
    for (const base of bases) {
      const project = path.join(base, 'skill-proposals', key);
      try {
        if (!exists(project)?.isDirectory()) continue;
        const names = fs.readdirSync(project).filter(name => ARCHIVE_NAME.exec(name)?.[1] === run).sort().reverse();
        for (const name of names) {
          const folder = path.join(project, name);
          if (!exists(folder)?.isDirectory()) continue;
          const index = path.join(fs.realpathSync.native(folder), 'index.json');
          if (exists(index)?.isFile()) return index;
        }
      } catch { /* Try the next storage location. */ }
    }
  } catch { /* An unavailable archive does not hide the role status. */ }
  return null;
}

function pruneArchives(project, now) {
  const complete = [];
  const remove = folder => {
    if (path.dirname(fs.realpathSync.native(folder)) === project) fs.rmSync(folder, { recursive: true, force: true });
  };
  for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ARCHIVE_NAME.test(entry.name)) continue;
    const folder = path.join(project, entry.name);
    try {
      const index = exists(path.join(folder, 'index.json'));
      if (index?.isFile()) complete.push({ folder, time: index.mtimeMs });
      else if (!index && now - Number(entry.name.slice(0, 13)) >= 7 * 86400000) remove(folder);
    } catch { /* Another helper may have removed the archive. */ }
  }
  complete.sort((a, b) => b.time - a.time || b.folder.localeCompare(a.folder));
  for (const { folder } of complete.slice(RETAIN_RUNS)) {
    try { remove(folder); } catch { /* Retry on the next save. */ }
  }
}

function preview(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(PREVIEW_BYTES);
    const bytes = fs.readSync(fd, buffer);
    const truncated = fs.fstatSync(fd).size > bytes;
    const text = truncated ? new StringDecoder('utf8').write(buffer.subarray(0, bytes)) : buffer.toString('utf8', 0, bytes);
    return { text, truncated };
  } finally { fs.closeSync(fd); }
}

function receiptDetails(indexPath, proposals) {
  const count = proposals.length;
  const sizeOf = proposal => Buffer.byteLength(JSON.stringify(proposal)) + 1;
  if (proposals.reduce((total, proposal) => total + sizeOf(proposal), 0) <= RECEIPT_BYTES) return { indexPath, count, proposals };
  const selected = [];
  let available = RECEIPT_BYTES;
  // Reserve space for paths and operations before adding text to the receipt.
  for (const { text, ...proposal } of proposals) {
    if (text !== undefined) proposal.truncated = true;
    const bytes = sizeOf(proposal);
    if (bytes > available) break;
    available -= bytes;
    selected.push(proposal);
  }
  for (let i = 0; i < selected.length; i++) {
    const extra = sizeOf(proposals[i]) - sizeOf(selected[i]);
    if (extra > available) continue;
    selected[i] = proposals[i];
    available -= extra;
  }
  return { indexPath, count, proposals: selected, previewsInIndex: true };
}

class WorkerSkillProposals {
  constructor(options, env, repo = repoFiles(options.cwd)) {
    this.repo = repo;
    const root = repo?.root || options.cwd;
    const delivery = managedDelivery(options.cwd, env);
    const worktree = worktreeRoots(options.cwd);
    this.archive = () => archiveProject(env, delivery, options.cwd, root, worktree.main);
    this.managed = delivery.roots || [];
    this.builtinNames = Array.isArray(delivery.builtinNames) ? delivery.builtinNames.filter(name => typeof name === 'string') : [];
    this.builtinRoot = this.managed.includes(delivery.builtinRoot) ? delivery.builtinRoot : null;
    this.restoreRoot = worktree.root && canonical(worktree.root) !== canonical(worktree.main) ? worktree.root : null;
    const projectRoots = [root, options.cwd].flatMap(folder => ['skills', '.claude/skills', '.codex/skills'].map(name => path.join(folder, name)));
    this.userRoots = new Set(projectRoots.concat(this.managed.filter(folder => folder !== this.builtinRoot)).map(canonical));
    this.roots = [...new Set(projectRoots.concat(this.managed).map(folder => path.resolve(folder)))];
    this.approved = new Set(options.allow.filter(file => skillFile(file) && !/[*?[\]{}]/.test(file)).map(file => canonical(path.resolve(root, file))));
    this.notes = new Set(); this.reportOnly = false;
    this.before = this.scan(); this.done = false;
  }

  limited() {
    this.reportOnly = true;
    this.notes.add('skill guard report-only: snapshot limits exceeded');
  }

  scan(extraFiles = []) {
    const files = new Map();
    let visited = 0, bytes = 0;
    const add = (file, root) => {
      noLinks(root, path.dirname(file));
      const stat = exists(file);
      if (!stat) return;
      if (files.has(canonical(file))) return;
      bytes += stat.size;
      if (files.size >= 4096) { this.limited(); return; }
      const large = stat.size > 512 * 1024 || bytes > 20 * 1024 * 1024;
      if (large) this.limited();
      const value = stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isFile()
        ? large ? { hash: fileHash(file) } : { bytes: fs.readFileSync(file) } : { directory: true };
      if (value.bytes) value.hash = createHash('sha256').update(value.bytes).digest('hex');
      files.set(canonical(file), { file, root, mode: stat.mode, ...value });
    };
    const walk = (root, anchor = root) => {
      if (++visited > 8192) { this.limited(); return; }
      const stat = exists(root);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const file = path.join(root, entry.name);
        if (skillFile(file)) add(file, anchor);
        else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file, anchor);
      }
    };
    for (const root of this.roots) walk(root);
    if (this.repo) for (const file of new Set([...this.repo.files, ...extraFiles])) {
      if (skillFile(file) && !file.split(/[\\/]/).some(name => name === 'node_modules' || name === '.git')) add(path.join(this.repo.root, file), this.repo.root);
    }
    return files;
  }

  finish(id, changedFiles) {
    if (this.done) return this.count;
    const after = this.scan(changedFiles ?? (this.repo && repoFiles(this.repo.root)?.files) ?? []), proposals = [];
    let project, folder;
    for (const key of new Set([...this.before.keys(), ...after.keys()])) {
      const before = this.before.get(key), current = after.get(key);
      if (before?.hash && before.hash === current?.hash
        || before?.link && before.link === current?.link || before?.directory && current?.directory) continue;
      // A bounded scan cannot establish a deletion for a file it did not reach.
      if (!current && before && exists(before.file)) continue;
      const entry = before || current;
      let rejected = null;
      if (current && this.userRoots.has(canonical(path.dirname(path.dirname(entry.file))))) {
        try {
          assertUserSkillName(path.basename(path.dirname(entry.file)), this.builtinNames);
          const declared = current.bytes && frontMatter(current.bytes.toString('utf8'))?.fields.name;
          assertUserSkillName(declared?.toLowerCase(), this.builtinNames);
        } catch (error) { rejected = error.message; }
      }
      if (this.approved.has(key) && !rejected) continue;
      const restored = !this.reportOnly && this.restoreRoot && within(this.restoreRoot, entry.file)
        && !this.managed.some(root => within(root, entry.file)) && !current?.directory;
      const proposal = { path: entry.file, operation: !current ? 'delete' : !before ? 'create' : 'edit', restored: Boolean(restored) };
      if (rejected) { proposal.rejected = true; proposal.error = rejected; this.notes.add(rejected); }
      if (!restored) proposal.note = 'changed during the run, author unknown';
      if (!folder) {
        project = this.archive();
        folder = fs.mkdtempSync(path.join(project, `${Date.now()}-${archiveId(id)}-`));
      }
      const indexPath = path.join(folder, 'index.json');
      const saved = current ?? (before?.bytes ? before : null);
      if (saved?.bytes || saved?.hash) {
        proposal.content = `${proposals.length + 1}.SKILL.md`;
        proposal.savedPath = path.join(folder, proposal.content);
        if (saved.bytes) fs.writeFileSync(proposal.savedPath, saved.bytes, { flag: 'wx', mode: 0o600 });
        else { fs.copyFileSync(saved.file, proposal.savedPath, fs.constants.COPYFILE_EXCL); fs.chmodSync(proposal.savedPath, 0o600); }
        Object.assign(proposal, preview(proposal.savedPath));
      } else {
        proposal.savedPath = indexPath;
        if (current?.link) proposal.symlink = current.link;
        else if (current?.directory) proposal.directory = true;
      }
      proposals.push(proposal);
    }
    // Preserve every proposed version before restoring any active file.
    if (folder) {
      const indexPath = path.join(folder, 'index.json'), pending = path.join(folder, 'pending.json');
      fs.writeFileSync(pending, JSON.stringify({ version: 1, runId: id, proposals }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(pending, indexPath);
      this.details = receiptDetails(indexPath, proposals);
      try { pruneArchives(project, Date.now()); }
      catch { this.notes.add('skill proposal archive cleanup failed; retrying on the next save'); }
    }
    for (const proposal of proposals) {
      if (!proposal.restored) continue;
      const key = canonical(proposal.path), before = this.before.get(key), entry = before || after.get(key);
      noLinks(entry.root, path.dirname(entry.file));
      if (exists(entry.file)) fs.unlinkSync(entry.file);
      if (!before) continue;
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      if (before.link) fs.symlinkSync(before.link, entry.file);
      else if (before.bytes) fs.writeFileSync(entry.file, before.bytes, { flag: 'wx', mode: before.mode });
    }
    this.count = proposals.length;
    this.restoredCount = proposals.filter(proposal => proposal.restored).length;
    this.done = true;
    return this.count;
  }
}

module.exports = { WorkerSkillProposals, findSkillProposalIndex };
