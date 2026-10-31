// A dispatched worker can propose a skill edit; only a literal --allow path approves applying it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
    this.roots = [...new Set([root, options.cwd].flatMap(folder => ['skills', '.claude/skills', '.codex/skills'].map(name => path.join(folder, name)))
      .concat(managedRoots(options.cwd, env)).map(folder => path.resolve(folder)))];
    this.approved = new Set(options.allow.filter(file => skillFile(file) && !/[*?[\]{}]/.test(file)).map(file => canonical(path.resolve(root, file))));
    this.before = this.scan(); this.done = false; this.artifacts = new Set();
  }

  scan(extraFiles = []) {
    const files = new Map();
    let visited = 0, bytes = 0;
    const add = (file, root) => {
      noLinks(root, path.dirname(file));
      const stat = exists(file);
      if (!stat) return;
      bytes += stat.size;
      if (files.size >= 4096 || stat.size > 512 * 1024 || bytes > 20 * 1024 * 1024) throw new Error('Worker skill snapshot exceeds its size limit');
      const value = stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isFile() ? { bytes: fs.readFileSync(file) } : { directory: true };
      files.set(canonical(file), { file, root, mode: stat.mode, ...value });
    };
    const walk = (root, anchor = root) => {
      if (++visited > 8192) throw new Error('Worker skill roots exceed their directory limit');
      const stat = exists(root);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (skillFile(file)) add(file, anchor);
        else if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file, anchor);
      }
    };
    for (const root of this.roots) walk(root);
    if (this.repo) for (const file of new Set([...this.repo.files, ...extraFiles])) if (skillFile(file)) add(path.join(this.repo.root, file), this.repo.root);
    return files;
  }

  finish(id, changedFiles) {
    if (this.done) return this.count;
    const after = this.scan(changedFiles ?? (this.repo && repoFiles(this.repo.root)?.files) ?? []), proposals = [];
    const folder = `${this.options.out}.skill-proposals-${id}`;
    for (const key of new Set([...this.before.keys(), ...after.keys()])) {
      const before = this.before.get(key), current = after.get(key);
      if (this.approved.has(key) || before?.bytes && current?.bytes && before.bytes.equals(current.bytes)
        || before?.link && before.link === current?.link || before?.directory && current?.directory) continue;
      const entry = before || current;
      const proposal = { path: entry.file, operation: !current ? 'delete' : !before ? 'create' : 'edit' };
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (current?.bytes) {
        proposal.content = `${proposals.length + 1}.SKILL.md`;
        fs.writeFileSync(path.join(folder, proposal.content), current.bytes, { flag: 'wx', mode: 0o600 });
        this.artifacts.add(path.join(folder, proposal.content));
      } else if (current?.link) proposal.symlink = current.link;
      else if (current?.directory) throw new Error('A worker replaced SKILL.md with a directory; manual recovery required');
      proposals.push(proposal);
    }
    // Preserve every proposed version before restoring any active file.
    if (proposals.length) {
      fs.writeFileSync(path.join(folder, 'index.json'), JSON.stringify({ version: 1, proposals }, null, 2), { flag: 'wx', mode: 0o600 });
      this.artifacts.add(path.join(folder, 'index.json'));
    }
    for (const proposal of proposals) {
      const key = canonical(proposal.path), before = this.before.get(key), entry = before || after.get(key);
      noLinks(entry.root, path.dirname(entry.file));
      if (exists(entry.file)) fs.unlinkSync(entry.file);
      if (!before) continue;
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      if (before.link) fs.symlinkSync(before.link, entry.file);
      else if (before.bytes) fs.writeFileSync(entry.file, before.bytes, { flag: 'wx', mode: before.mode });
    }
    this.count = proposals.length; this.done = true;
    return this.count;
  }
}

module.exports = { WorkerSkillProposals };
