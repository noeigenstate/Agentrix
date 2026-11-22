// Repository-wide coordination for dispatched workers. Git's common directory is shared by worktrees and stays uncommitted.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { queueControl, recordControl, controlOf } = require('./inbox.cjs');
const { globRegExp } = require('../../boundaries.cjs');

const FINDINGS = '## Findings for the ledger';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
const nonnegative = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function projectTeam(cwd, create = false) {
  let common;
  try { common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim()); } catch { return null; }
  return teamAt(common, cwd, create);
}

// The team in Git's common directory `common` (absolute), as found from `cwd`. team-locate.cjs asks Git without blocking.
function teamAt(common, cwd, create = false) {
  // Hosts may confine shared journal writes to explicitly admitted Git directories.
  const roots = process.env.AGENTRIX_TEAM_WRITE_ROOTS;
  if (roots) {
    const real = fs.realpathSync.native(common);
    if (!roots.split(path.delimiter).filter(Boolean).some(root => {
      let admitted; try { admitted = fs.realpathSync.native(root); } catch { return false; }
      const relative = path.relative(admitted, real);
      return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    })) return null;
  }
  const directory = path.join(common, 'agentrix');
  if (!create && !fs.existsSync(directory)) return null;
  if (create) {
    fs.mkdirSync(path.join(directory, 'board'), { recursive: true });
    fs.closeSync(fs.openSync(path.join(directory, 'memory.md'), 'a'));
  }
  return new Team(directory, cwd);
}

const MEMORY_LIMIT = 6 * 1024;
const commonWords = new Set(('about after and are before brief can change changes check code does file files fix for from had has have how '
  + 'implement inspect into investigate keep must new not only our read report review role see should task test tests that the their them then this '
  + 'update use verify was what when will with work would you 任务 代码 修复 文件 测试 角色').split(' '));
const words = text => (text.toLowerCase().match(/[a-z][a-z0-9_]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || [])
  .flatMap(word => {
    if (/^[a-z]/.test(word)) return [word];
    const chars = Array.from(word);
    return chars.slice(1).map((char, index) => chars[index] + char);
  }).filter(word => !commonWords.has(word));
const paths = text => (text.toLowerCase().replaceAll('\\', '/').match(/[\p{L}\d_.-]+(?:\/[\p{L}\d_.-]+)+|[\p{L}\d_-]+\.[a-z][a-z\d]+/gu) || [])
  .flatMap(raw => {
    const file = raw.replace(/\.+$/, '');
    return file.includes('/') ? [file, file.split('/').at(-1)] : [file];
  });

const memoryEntry = /^(?:### \d{4}-\d{2}-\d{2}(?=[T\s])|## Round\b)/;
const truncated = '\n\n[Entry truncated]';
function fitEntry(entry, budget) {
  if (Buffer.byteLength(entry) <= budget) return entry;
  const available = budget - Buffer.byteLength(truncated);
  const paragraphs = entry.replaceAll('\r\n', '\n').split(/\n[ \t]*\n/);
  const kept = [];
  let bytes = 0;
  for (const paragraph of paragraphs) {
    const size = Buffer.byteLength(paragraph) + (kept.length ? 2 : 0);
    if (bytes + size > available) break;
    kept.push(paragraph); bytes += size;
  }
  const heading = entry.split('\n', 1)[0].trimEnd();
  if (kept.length) return kept.join('\n\n') + truncated;
  if (available < 1) return '';
  let clipped = '';
  for (const char of heading) {
    bytes += Buffer.byteLength(char);
    if (bytes > available) break;
    clipped += char;
  }
  return clipped + truncated;
}

function memoryExcerpt(text, { allow = [], brief = '' } = {}) {
  const taskWords = new Set(words(brief)), taskPaths = new Set(paths(brief));
  const globs = allow.map(glob => globRegExp(glob.toLowerCase()));
  const entries = text.split(/(?=^### \d{4}-\d{2}-\d{2}(?=[T\s])|^## Round\b|^# )/m)
    .map(entry => entry.trim()).filter(entry => memoryEntry.test(entry)).reverse();
  const chosen = [];
  let remaining = MEMORY_LIMIT;
  for (const [index, entry] of entries.entries()) {
    if (index >= 2 && !paths(entry).some(file => taskPaths.has(file) || globs.some(glob => glob.test(file)))
        && !words(entry).some(word => taskWords.has(word))) continue;
    const gap = chosen.length ? 2 : 0;
    const reserve = index === 0 && entries.length > 1 ? Math.min(MEMORY_LIMIT / 2, Buffer.byteLength(entries[1]) + 2) : 0;
    const excerpt = fitEntry(entry, remaining - gap - reserve);
    if (!excerpt) continue;
    chosen.push(excerpt);
    remaining -= Buffer.byteLength(excerpt) + gap;
  }
  return chosen.join('\n\n');
}

// Findings reach project memory as well as an explicit task ledger, with one append when they are the same file.
function recordFindings(options, answer, header) {
  const at = answer.indexOf(FINDINGS);
  if (at < 0) return false;
  const findings = answer.slice(at + FINDINGS.length).split(/\n#{1,2} /)[0].trim();
  const destinations = [...new Set([options.memory, options.ledger].filter(Boolean).map(file => path.resolve(file)))];
  if (!findings || !destinations.length) return false;
  for (const file of destinations) fs.appendFileSync(file, `\n\n### ${header}\n\n${findings}\n`);
  return true;
}

class Team {
  constructor(directory, cwd) {
    this.directory = directory; this.cwd = cwd;
    this.memory = path.join(directory, 'memory.md');
    this.journal = path.join(directory, 'journal.jsonl');
    this.board = path.join(directory, 'board');
  }
  entries() {
    return read(this.journal).split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { const entry = JSON.parse(line); return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry] : []; } catch { return []; }
    });
  }
  append(entry) { fs.appendFileSync(this.journal, JSON.stringify({ ...entry, time: Date.now() }) + '\n'); }
  queueControl(id, control, notify) { return queueControl(this, id, control, notify); }
  recordControl(id, title, control, notify) { return this.locked(() => recordControl(this, id, title, controlOf(control), notify)); }
  async locked(action) {
    const file = path.join(this.directory, 'lock'), token = randomUUID(), deadline = Date.now() + 15000;
    let stale;
    for (;;) {
      if (stale) {
        try {
          fs.unlinkSync(stale); stale = null;
        } catch (failure) {
          if (failure.code === 'ENOENT') stale = null;
          else if (failure.code !== 'EPERM' && failure.code !== 'EBUSY') throw failure;
        }
      }
      if (!stale) {
        let fd;
        try {
          fd = fs.openSync(file, 'wx');
        } catch (error) {
          // Windows can deny an exclusive open while the previous lock is pending deletion. Wait without touching it.
          if (error.code === 'EEXIST') {
            let expired = false;
            try { expired = Date.now() - fs.statSync(file).mtimeMs > 10000; }
            catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
            if (expired) {
              const candidate = file + '.' + randomUUID() + '.stale';
              try { fs.renameSync(file, candidate); stale = candidate; continue; }
              catch (failure) { if (!['ENOENT', 'EPERM', 'EBUSY'].includes(failure.code)) throw failure; }
            }
          } else if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
            throw error;
          }
        }
        if (fd !== undefined) {
          try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
          break;
        }
      }
      if (Date.now() <= deadline) await delay(25);
      if (Date.now() > deadline) throw new Error('Team lock is busy');
    }
    try { return await action(); } finally { if (read(file) === token) fs.unlinkSync(file); }
  }
  live() {
    const entries = [];
    for (const name of fs.readdirSync(this.board)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.board, name);
      let entry, alive = false;
      try {
        entry = JSON.parse(read(file));
        if (Number.isSafeInteger(entry.pid) && entry.pid > 0 && Array.isArray(entry.allow) && entry.allow.every(glob => typeof glob === 'string')) {
          try { process.kill(entry.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
        }
      } catch {}
      if (alive) entries.push(entry);
      else fs.rmSync(file, { force: true });
    }
    return entries;
  }
  register(options, id) {
    const entry = { id, pid: process.pid, title: options.title, role: options.role, agent: options.agent, model: options.model,
      cwd: options.cwd, allow: options.allow, startedAt: Date.now() };
    const temporary = path.join(this.board, id + '.tmp');
    fs.writeFileSync(temporary, JSON.stringify(entry));
    fs.renameSync(temporary, path.join(this.board, id + '.json'));
  }
  release(id) {
    for (const extension of ['.json', '.tmp']) fs.rmSync(path.join(this.board, id + extension), { force: true });
  }
  context(id, before, { small, readOnly, allow, brief } = {}) {
    const workers = this.live().filter(worker => worker.id !== id);
    const working = workers.map(worker => `- ${worker.title} (${worker.agent} ${worker.model}, ${worker.role}): ${worker.allow.length ? worker.allow.join(', ') : 'no file changes'}`).join('\n');
    let status = '', log = '';
    if (before !== undefined) {
      const name = file => /[\s"\\]/.test(file) ? JSON.stringify(file) : file;
      status = before ? before.status.map(entry => `${entry.status} ${entry.source ? name(entry.source) + ' -> ' : ''}${name(entry.file)}`).join('\n') : '(status unavailable)';
    } else {
      try { status = git(this.cwd, ['-c', 'core.quotepath=false', 'status', '--short']).trimEnd(); } catch { status = '(status unavailable)'; }
    }
    try { log = git(this.cwd, ['log', '--oneline', '-5']).trim(); } catch { log = '(history unavailable)'; }
    const lines = status.split(/\r?\n/).filter(Boolean);
    const relative = path.relative(this.cwd, this.memory);
    const outside = path.isAbsolute(relative) || relative.startsWith('..' + path.sep);
    const pointer = readOnly && outside
      ? 'The full project memory is outside the role folder and cannot be read from this role. The lead can supply an entry on request.'
      : `Full project memory: ${this.memory}`;
    const memory = small ? [] : [`# Project memory\n\n${pointer}\n\n${memoryExcerpt(read(this.memory), { allow, brief })}`.trimEnd()];
    return [...memory, `# Working now\n\n${working || '- none'}`,
      `# Repository\n\n${lines.slice(0, 40).join('\n') || '(clean)'}${lines.length > 40 ? `\n… and ${lines.length - 40} more` : ''}\n\n${log || '(no commits)'}`];
  }
  finish(options, report) {
    return this.locked(() => {
      recordFindings({ ...options, memory: this.memory }, report.answer, report.header);
      this.append({ type: 'end', id: report.id, agent: options.agent, title: String(options.title || '').slice(0, 240), session: report.session || options.resume || null,
        role: options.role, kind: report.kind ?? null, model: report.model || 'unreported',
        reason: report.reason, outputTokens: nonnegative(report.outputTokens) ? report.outputTokens : null,
        totalOutputTokens: nonnegative(report.totalOutputTokens) ? report.totalOutputTokens : null,
        activeMs: nonnegative(report.activeMs) ? report.activeMs : null });
    });
  }
}

module.exports = { projectTeam, teamAt, memoryExcerpt, recordFindings, FINDINGS };
