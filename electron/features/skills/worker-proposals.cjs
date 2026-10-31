// A dispatched worker can propose a skill edit; only a literal --allow path approves applying it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { repoFiles } = require('../../boundaries.cjs');
const { readDelivery } = require('./session.cjs');

const skillFile = file => path.basename(file).toLowerCase() === 'skill.md';
const canonical = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } };
const within = (root, file) => { const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };

function commonDir(cwd) {
  try {
    return canonical(fs.realpathSync.native(path.resolve(cwd, execFileSync('git', ['rev-parse', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim())));
  } catch { return null; }
}

function isolatedWorktree(cwd) {
  try {
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    const root = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']));
    const main = fs.realpathSync.native(git(['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length));
    return canonical(root) !== canonical(main) ? root : null;
  } catch { return null; }
}

function fileHash(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  try { for (let count; (count = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function managedRoots(cwd, env) {
  try {
    const note = env.AGENTRIX_READING_NOTE_FILE ? fs.readFileSync(env.AGENTRIX_READING_NOTE_FILE, 'utf8') : env.AGENTRIX_READING_NOTE;
    const delivery = readDelivery(note);
    if (!delivery) return [];
    const metadata = JSON.parse(fs.readFileSync(`${delivery.manifest}.json`, 'utf8'));
    if (metadata.fingerprint !== delivery.fingerprint || typeof metadata.projectRoot !== 'string') return [];
    // An inherited startup note for a different project must never make a test or unrelated worker read its skills.
    const sameRepo = commonDir(cwd), projectRepo = commonDir(metadata.projectRoot);
    if (!within(metadata.projectRoot, cwd) && (!sameRepo || sameRepo !== projectRepo)) return [];
    if (!Array.isArray(metadata.roots) || metadata.roots.length > 32 || !metadata.roots.every(root => typeof root === 'string' && path.isAbsolute(root))) return [];
    return metadata.roots;
  } catch { return []; }
}

function noLinks(root, file) {
  if (!within(root, file)) throw new Error('Skill path escaped its declared root');
  for (let current = file; ; current = path.dirname(current)) {
    if (exists(current)?.isSymbolicLink()) throw new Error('Refusing a symlink in a skill path');
    if (canonical(current) === canonical(root)) return;
  }
}

class WorkerSkillProposals {
  constructor(options, env, repo = repoFiles(options.cwd)) {
    this.options = options; this.repo = repo;
    const root = repo?.root || options.cwd;
    this.managed = managedRoots(options.cwd, env);
    this.restoreRoot = isolatedWorktree(options.cwd);
    this.roots = [...new Set([root, options.cwd].flatMap(folder => ['skills', '.claude/skills', '.codex/skills'].map(name => path.join(folder, name)))
      .concat(this.managed).map(folder => path.resolve(folder)))];
    this.approved = new Set(options.allow.filter(file => skillFile(file) && !/[*?[\]{}]/.test(file)).map(file => canonical(path.resolve(root, file))));
    this.notes = new Set(); this.reportOnly = false;
    this.before = this.scan(); this.done = false; this.artifacts = new Set();
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
    const folder = `${this.options.out}.skill-proposals-${id}`;
    for (const key of new Set([...this.before.keys(), ...after.keys()])) {
      const before = this.before.get(key), current = after.get(key);
      if (this.approved.has(key) || before?.hash && before.hash === current?.hash
        || before?.link && before.link === current?.link || before?.directory && current?.directory) continue;
      // A bounded scan cannot establish a deletion for a file it did not reach.
      if (!current && before && exists(before.file)) continue;
      const entry = before || current;
      const restored = !this.reportOnly && this.restoreRoot && within(this.restoreRoot, entry.file)
        && !this.managed.some(root => within(root, entry.file)) && !current?.directory;
      const proposal = { path: entry.file, operation: !current ? 'delete' : !before ? 'create' : 'edit', restored: Boolean(restored) };
      if (!restored) proposal.note = 'changed during the run, author unknown';
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (current?.bytes || current?.hash) {
        proposal.content = `${proposals.length + 1}.SKILL.md`;
        const destination = path.join(folder, proposal.content);
        if (current.bytes) fs.writeFileSync(destination, current.bytes, { flag: 'wx', mode: 0o600 });
        else { fs.copyFileSync(current.file, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o600); }
        this.artifacts.add(path.join(folder, proposal.content));
      } else if (current?.link) proposal.symlink = current.link;
      else if (current?.directory) proposal.directory = true;
      proposals.push(proposal);
    }
    // Preserve every proposed version before restoring any active file.
    if (proposals.length) {
      fs.writeFileSync(path.join(folder, 'index.json'), JSON.stringify({ version: 1, proposals }, null, 2), { flag: 'wx', mode: 0o600 });
      this.artifacts.add(path.join(folder, 'index.json'));
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

module.exports = { WorkerSkillProposals };
