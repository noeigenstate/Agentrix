const process = require('node:process');
// Repository-wide coordination for dispatched workers. Git's common directory is shared by worktrees and stays uncommitted.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { queueControl, recordControl, controlOf, readBoard, boardEntry, readRows } = require('./inbox.cjs');
const { globRegExp } = require('../../boundaries.cjs');

const FINDINGS = '## Findings for the ledger';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const read = (file, missing = '', encoding = 'utf8') => {
  try { return fs.readFileSync(file, encoding); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
};
const jsonLine = value => JSON.stringify(value) + '\n';
const nonnegative = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const MEMORY_ACTIVE_BYTES = 4 * 1024 * 1024, JOURNAL_ACTIVE_BYTES = 16 * 1024 * 1024;
const LOCK_RETRY = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM', 'EACCES', 'EBUSY']);

function clearDeadLock(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory()) {
      if (Date.now() - stat.mtimeMs > 10_000) fs.unlinkSync(file);
      return;
    }
    const names = fs.readdirSync(file);
    if (!names.length) { fs.rmdirSync(file); return; }
    if (names.length !== 1) return;
    const owner = /^(\d+)-[\da-f-]{36}$/.exec(names[0]);
    if (!owner) return;
    try { process.kill(Number(owner[1]), 0); return; }
    catch (error) { if (error.code !== 'ESRCH') return; }
    fs.unlinkSync(path.join(file, names[0]));
    fs.rmdirSync(file);
  } catch (error) { if (error.code === 'EACCES' || !LOCK_RETRY.has(error.code)) throw error; }
}

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

const memoryPath = file => path.join(path.dirname(file), path.parse(file).name + '.jsonl');
const memoryEntry = ({ at = Date.now(), title, text, runId, source }) => ({
  v: 1, type: 'memory.entry', at, title, text, ...(runId && { runId }), ...(source && { source }),
});
const trimBlankLines = text => text.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');

// Legacy import only. Keep free text before the first heading and all text between headings.
function importLegacyMemory(original) {
  const markdown = original.replace(/^\uFEFF/, '');
  const headings = [...markdown.matchAll(/^(?:### \d{4}-\d{2}-\d{2}(?=[T\s]|$)|## Round\b)[^\r\n]*/gm)];
  const entries = headings.map(({ 0: title, index }, position) => {
    const text = trimBlankLines(markdown.slice(index + title.length, headings[position + 1]?.index));
    const stamp = title.slice(4).split(' · ', 1)[0].replace(' ', 'T');
    const at = Date.parse(/T\d\d:\d\d(?::\d\d)?$/.test(stamp) ? stamp + 'Z' : stamp);
    return memoryEntry({ at: Number.isFinite(at) ? at : 0, title, text, source: 'legacy-markdown' });
  });
  const preface = trimBlankLines(markdown.slice(0, headings[0]?.index));
  if (preface) entries.unshift(memoryEntry({ at: 0, title: '', text: preface, source: 'legacy-preface' }));
  return entries;
}

function writeMemoryFile(file, text, once = false) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    if (once) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } catch (error) {
    if (!once || error.code !== 'EEXIST') throw error;
  } finally { fs.rmSync(temporary, { force: true }); }
}

function rotate(file, data, limit) {
  if (data.length <= limit) return data;
  const split = data.indexOf(10, data.length - Math.floor(limit / 2)) + 1;
  if (!split || split === data.length) return data;
  // Keep a recoverable copy before replacing the active file. Readers see the archive only after the swap.
  const archive = `${file}.${Date.now()}-${randomUUID()}.archive`, pending = archive + '.pending';
  writeMemoryFile(pending, data.subarray(0, split), true);
  const retained = data.subarray(split);
  try { writeMemoryFile(file, retained); }
  catch (error) { fs.rmSync(pending, { force: true }); throw error; }
  fs.renameSync(pending, archive);
  return retained;
}

function initializeMemory(markdownFile, file) {
  const original = read(markdownFile, null, null);
  const backup = path.join(path.dirname(markdownFile), path.parse(markdownFile).name + '.legacy.md');
  if (original !== null) writeMemoryFile(backup, original, true);
  // Publish only a complete import, and let concurrent worktrees use the same original snapshot.
  writeMemoryFile(file, importLegacyMemory(read(backup)).map(jsonLine).join(''), true);
  return read(file);
}

const memoryHeading = ({ title, source }) => source === 'legacy-markdown' || !title ? title : '### ' + title;
const validMemory = value => value.type === 'memory.entry' && nonnegative(value.at) && typeof value.title === 'string'
  && (typeof value.text === 'string' || value.text && typeof value.text === 'object' && !Array.isArray(value.text));
function renderMemoryEntry(entry) {
  const { text } = entry;
  return [memoryHeading(entry), typeof text === 'string' ? text : JSON.stringify(text)].filter(Boolean).join('\n\n');
}

function syncMemory(markdownFile, file, addition, compact = false) {
  let data = read(file, null) ?? initializeMemory(markdownFile, file);
  for (;;) {
    if (addition) {
      const entry = memoryEntry(addition);
      const line = (data && !data.endsWith('\n') ? '\n' : '') + jsonLine(entry);
      fs.appendFileSync(file, line);
      data += line;
      addition = null;
      if (compact) data = rotate(file, Buffer.from(data), MEMORY_ACTIVE_BYTES).toString('utf8');
    }
    const { entries: rows, skipped } = readRows(data.split(/\r?\n/), 'memory.jsonl', validMemory);
    const heading = '<!-- Generated project memory. Record findings through Agentrix. Older entries may be in memory.jsonl.*.archive. -->\n';
    const notice = skipped ? `\n[Skipped ${skipped} unreadable memory rows.]\n` : '';
    const rendered = heading + notice + rows.map(row => '\n' + renderMemoryEntry(row) + '\n').join('');
    if (read(markdownFile, null) !== rendered) writeMemoryFile(markdownFile, rendered);
    const current = read(file);
    if (current === data) return { rows, skipped };
    // A worktree can append while a synchronous brief is refreshing the human view.
    data = current;
  }
}

const truncated = '\n\n[Entry truncated]';
function fitEntry(entry, heading, budget) {
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
  if (kept.length) return kept.join('\n\n') + truncated;
  if (available < 1) return '';
  let clipped = '';
  for (const char of heading.trimEnd()) {
    bytes += Buffer.byteLength(char);
    if (bytes > available) break;
    clipped += char;
  }
  return clipped + truncated;
}

function memoryExcerpt(rows, { allow = [], brief = '' } = {}) {
  const taskWords = new Set(words(brief)), taskPaths = new Set(paths(brief));
  const globs = allow.map(glob => globRegExp(glob.toLowerCase()));
  const entries = rows.filter(entry => entry.source !== 'legacy-preface').reverse();
  const chosen = [];
  let remaining = MEMORY_LIMIT;
  for (const [index, row] of entries.entries()) {
    const entry = renderMemoryEntry(row);
    if (index >= 2 && !paths(entry).some(file => taskPaths.has(file) || globs.some(glob => glob.test(file)))
        && !words(entry).some(word => taskWords.has(word))) continue;
    const gap = chosen.length ? 2 : 0;
    const reserve = index === 0 && entries.length > 1 ? Math.min(MEMORY_LIMIT / 2, Buffer.byteLength(renderMemoryEntry(entries[1])) + 2) : 0;
    const excerpt = fitEntry(entry, memoryHeading(row), remaining - gap - reserve);
    if (!excerpt) continue;
    chosen.push(excerpt);
    remaining -= Buffer.byteLength(excerpt) + gap;
  }
  return chosen.join('\n\n');
}

// Legacy 1.6.4 fallback for workers that returned only final text.
function legacyFindings(answer) {
  const at = answer.indexOf(FINDINGS);
  return at < 0 ? '' : answer.slice(at + FINDINGS.length).split(/\n#{1,2} /)[0].trim();
}

function recordFindings({ memory, ledger }, findings, header, runId, compact = false) {
  const structured = Array.isArray(findings);
  const text = structured ? findings.filter(item => typeof item === 'string' && item.trim()).map(item => '- ' + item.trim()).join('\n')
    : typeof findings === 'string' ? legacyFindings(findings) : '';
  if (!text || !(memory || ledger)) return false;
  const entry = { title: String(header).replace(/[\r\n]/g, ' '), text, runId, source: structured ? 'findings' : 'legacy-findings' };
  if (memory) syncMemory(memory, memoryPath(memory), entry, compact);
  if (ledger && (!memory || path.resolve(ledger) !== path.resolve(memory))) fs.appendFileSync(ledger, '\n\n' + renderMemoryEntry(entry) + '\n');
  return true;
}

class Team {
  constructor(directory, cwd) {
    this.directory = directory; this.cwd = cwd;
    this.memory = path.join(directory, 'memory.md');
    this.memoryJsonl = memoryPath(this.memory);
    this.journal = path.join(directory, 'journal.jsonl');
    this.board = path.join(directory, 'board');
  }
  journalHistory() { return readRows(read(this.journal).split(/\r?\n/), 'journal.jsonl'); }
  entries() { return this.journalHistory().entries; }
  append(entry) {
    fs.appendFileSync(this.journal, jsonLine({ ...entry, v: 1, time: Date.now() }));
    if (fs.statSync(this.journal).size > JOURNAL_ACTIVE_BYTES) rotate(this.journal, read(this.journal, null, null), JOURNAL_ACTIVE_BYTES);
  }
  appendMemory(entry) { syncMemory(this.memory, this.memoryJsonl, entry, true); }
  appendReceipt(record) {
    const { id, at, messageId, status, reason } = record;
    this.append({ type: 'control-receipt', id, messageId, status, at, ...(reason !== undefined && { reason }) });
    this.appendMemory({ at, title: `${new Date(at).toISOString()} · owner intervention receipt`, runId: id, source: 'control-receipt',
      text: { messageId, status, ...(reason !== undefined && { reason }) } });
  }
  queueControl(id, control, notify) { return queueControl(this, id, control, notify); }
  recordControl(id, title, control, notify) { return this.locked(() => recordControl(this, id, title, controlOf(control), notify)); }
  async locked(action) {
    const file = path.join(this.directory, 'lock'), owner = `${process.pid}-${randomUUID()}`;
    const temporary = file + '.' + owner, deadline = Date.now() + 15_000;
    fs.mkdirSync(temporary);
    try {
      fs.closeSync(fs.openSync(path.join(temporary, owner), 'wx'));
      for (;;) {
        // A populated lock directory cannot be replaced. Keep old-style files on the legacy expiry path.
        if (fs.lstatSync(file, { throwIfNoEntry: false })) clearDeadLock(file);
        else {
          try { fs.renameSync(temporary, file); break; }
          catch (error) {
            if (!LOCK_RETRY.has(error.code) || process.platform !== 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          }
        }
        if (Date.now() > deadline) throw new Error('Team lock is busy');
        await delay(25);
        if (Date.now() > deadline) throw new Error('Team lock is busy');
      }
    } finally {
      if (fs.existsSync(temporary)) {
        fs.rmSync(path.join(temporary, owner), { force: true });
        fs.rmdirSync(temporary);
      }
    }
    try { return await action(); }
    finally {
      fs.unlinkSync(path.join(file, owner));
      try { fs.rmdirSync(file); }
      catch (error) { if (!LOCK_RETRY.has(error.code)) throw error; }
    }
  }
  live() {
    const entries = [];
    for (const name of fs.readdirSync(this.board)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.board, name);
      let entry, alive = false;
      try {
        entry = readBoard(read(file));
        if (entry) {
          try { process.kill(entry.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
        }
      } catch (error) { if (error.code?.startsWith('wire.')) throw error; }
      if (alive) entries.push(entry);
      else fs.rmSync(file, { force: true });
    }
    return entries;
  }
  register(options, id) {
    const entry = { id, pid: process.pid, title: options.title, role: options.role, agent: options.agent, model: options.model,
      cwd: options.cwd, allow: options.allow, startedAt: Date.now() };
    const temporary = path.join(this.board, id + '.tmp');
    fs.writeFileSync(temporary, jsonLine(boardEntry(entry)));
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
      : `Project memory (generated view): ${this.memory}`;
    const memory = [];
    if (!small) {
      const { rows, skipped } = syncMemory(this.memory, this.memoryJsonl);
      const notice = skipped ? `\n\n[Skipped ${skipped} unreadable memory rows.]` : '';
      memory.push(`# Project memory\n\n${pointer}${notice}\n\n${memoryExcerpt(rows, { allow, brief })}`.trimEnd());
    }
    return [...memory, `# Working now\n\n${working || '- none'}`,
      `# Repository\n\n${lines.slice(0, 40).join('\n') || '(clean)'}${lines.length > 40 ? `\n… and ${lines.length - 40} more` : ''}\n\n${log || '(no commits)'}`];
  }
  finish(options, report) {
    return this.locked(() => {
      recordFindings({ ...options, memory: this.memory }, report.findings ?? report.answer, report.header, report.id, true);
      this.append({ type: 'end', id: report.id, agent: options.agent, title: String(options.title || '').slice(0, 240), session: report.session || options.resume || null,
        role: options.role, kind: report.kind ?? null, model: report.model || 'unreported',
        reason: report.reason, outputTokens: nonnegative(report.outputTokens) ? report.outputTokens : null,
        totalOutputTokens: nonnegative(report.totalOutputTokens) ? report.totalOutputTokens : null,
        activeMs: nonnegative(report.activeMs) ? report.activeMs : null });
    });
  }
}

module.exports = { projectTeam, teamAt, memoryExcerpt, recordFindings, FINDINGS };
