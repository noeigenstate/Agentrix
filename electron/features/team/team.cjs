// Repository-wide coordination for dispatched workers. Git's common directory is shared by worktrees and stays uncommitted.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { matches, repoFiles } = require('../../boundaries.cjs');
const { LABELS, ISSUE_KEYS, blank, stamp, statusWord } = require('./minutes-page.cjs');

const FINDINGS = '## Findings for the ledger';
const fields = { Goal: 'goal', Files: 'files', Provides: 'provides', Uses: 'uses', 'Done when': 'doneWhen', 'Questions and risks': 'questions' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; } };
const sameScope = (a, b) => new Set(a).size === new Set(b).size && a.every(glob => b.includes(glob));
const kinds = ['core', 'frontend', 'test', 'ui-check', 'docs', 'small', 'review', 'investigate', 'roundtable'];
const boundedText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const nonnegative = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function roundRecords({ incidents = [], findings = [] }) {
  for (const [name, values] of [['incidents', incidents], ['findings', findings]]) {
    if (!Array.isArray(values) || values.length > 1000) throw new Error(`${name} must be an array of at most 1000 records`);
  }
  const result = [];
  for (const [index, incident] of incidents.entries()) {
    if (!shape(incident, ['model', 'kind', 'cause', 'fix', 'lead', 'weight']) || !boundedText(incident.model, 160) || !kinds.includes(incident.kind) ||
      !boundedText(incident.cause, 240) || !boundedText(incident.fix, 240) || ![null, 'missed', 'copied'].includes(incident.lead) ||
      incident.weight !== undefined && (!shape(incident.weight, ['kind', 'from', 'to']) || !kinds.includes(incident.weight.kind) ||
        !nonnegative(incident.weight.from) || !nonnegative(incident.weight.to))) throw new Error(`Invalid incidents[${index}]: expected model, kind, cause, fix, lead and optional weight`);
    result.push({ type: 'incident', model: incident.model, kind: incident.kind, cause: incident.cause, fix: incident.fix, lead: incident.lead,
      ...(incident.weight ? { weight: { kind: incident.weight.kind, from: incident.weight.from, to: incident.weight.to } } : {}) });
  }
  for (const [index, finding] of findings.entries()) {
    if (!shape(finding, ['author', 'reviewer', 'category', 'severity', 'fixed', 'title']) || !boundedText(finding.author, 160) ||
      !boundedText(finding.reviewer, 160) || !['correctness', 'security', 'performance', 'boundary', 'ui'].includes(finding.category) ||
      !['high', 'medium', 'low'].includes(finding.severity) || typeof finding.fixed !== 'boolean' || !boundedText(finding.title, 16384)) {
      throw new Error(`Invalid findings[${index}]: expected author, reviewer, category, severity, fixed and title`);
    }
    result.push({ type: 'finding', author: finding.author, reviewer: finding.reviewer, category: finding.category,
      severity: finding.severity, fixed: finding.fixed, title: finding.title.slice(0, 240) });
  }
  return result;
}

function blockOf(answer, heading) {
  const last = [...answer.matchAll(new RegExp('^## ' + heading + '[ \\t]*\\r?$', 'gm'))].at(-1);
  return last ? answer.slice(last.index + last[0].length).trim() : '';
}

function pendingMeetings(history) {
  const pending = new Set();
  for (const entry of history) {
    if (entry.type === 'end' && entry.meeting && entry.role !== '圆桌') pending.add(entry.meeting);
    if (entry.type === 'consolidate') pending.delete(entry.meeting);
  }
  return pending;
}

function projectTeam(cwd, create = false) {
  let common;
  try { common = path.resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim()); } catch { return null; }
  const directory = path.join(common, 'agentrix');
  if (!create && !fs.existsSync(directory)) return null;
  if (create) {
    fs.mkdirSync(path.join(directory, 'board'), { recursive: true });
    fs.closeSync(fs.openSync(path.join(directory, 'memory.md'), 'a'));
  }
  return new Team(directory, cwd);
}

function understandingOf(answer) {
  const block = blockOf(answer, 'Roundtable understanding');
  const understanding = {};
  let key = null, complete = true;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('#')) { complete = false; break; }
    const match = /^- (Goal|Files|Provides|Uses|Done when|Questions and risks):[ \t]*(.*)$/.exec(line);
    if (match) {
      key = fields[match[1]];
      if (Object.hasOwn(understanding, key)) complete = false;
      understanding[key] = match[2];
    } else if (key) understanding[key] += `\n${line}`;
    else if (line.trim()) complete = false;
  }
  for (const key of Object.keys(understanding)) understanding[key] = understanding[key].trim();
  return { understanding, status: complete && Object.values(fields).every(key => understanding[key] && understanding[key] !== '…') ? 'understood' : 'incomplete' };
}

function confirmationOf(answer) {
  const block = blockOf(answer, 'Roundtable confirmation');
  const status = /^Status:[ \t]*confirmed$/.test(block) ? 'confirmed' : 'open';
  return { status, confirmation: { status, questions: block.split(/\r?\n/).filter(line => /^- /.test(line)).map(line => line.slice(2)) } };
}

function meetingRequest(phase) {
  const instruction = phase === 'confirmation'
    ? 'The brief carries the roundtable minutes. Check that the other workers understand your shared interfaces the same way and that your questions are answered. End with exactly:\n\n'
      + '## Roundtable confirmation\nStatus: confirmed\n\nor use Status: open followed by bullet lines naming what is unresolved.'
    : 'Read the whole plan and restate your own task so the lead can check it before work. Answer in the language of the plan, ending with exactly this block (fields may continue on following lines; use none where empty):\n\n'
      + '## Roundtable understanding\n- Goal: …\n- Files: …\n- Provides: …\n- Uses: …\n- Done when: …\n- Questions and risks: …';
  return '# Roundtable before work\n\nThis run is the roundtable, not the work. Change no file in this run, including files in the agreed scope. '
    + instruction + '\n\nIf you have findings for the ledger, put that section before the final roundtable block.\n';
}

function memoryExcerpt(text) {
  const rounds = [...text.matchAll(/^## Round\b.*$/gm)];
  if (rounds.length) text = text.slice(rounds[Math.max(0, rounds.length - 2)].index);
  const bytes = Buffer.from(text), marker = '…\n', limit = 24 * 1024;
  if (bytes.length <= limit) return text.trim();
  let start = bytes.length - limit + Buffer.byteLength(marker);
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return marker + bytes.subarray(start).toString('utf8').trim();
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
        try {
          const fd = fs.openSync(file, 'wx');
          try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let expired = false;
          try { expired = Date.now() - fs.statSync(file).mtimeMs > 10000; }
          catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
          if (expired) {
            const candidate = file + '.' + randomUUID() + '.stale';
            try { fs.renameSync(file, candidate); stale = candidate; continue; }
            catch (failure) { if (!['ENOENT', 'EPERM', 'EBUSY'].includes(failure.code)) throw failure; }
          }
        }
      }
      if (Date.now() <= deadline) await delay(25);
      if (Date.now() > deadline) throw new Error('Team admission lock is busy; retry the dispatch');
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
      if (alive) entries.push({ ...entry, boardFile: file });
      else fs.rmSync(file, { force: true });
    }
    return entries;
  }
  async admit(options, id, helper = 'dispatch.cjs') {
    let repo;
    for (;;) {
      const admission = await this.locked(() => {
        const history = this.entries(), workers = this.live(), execution = options.role === '执行';
        const peers = workers.filter(worker => worker.role === '执行' && worker.id !== id && worker.allow.length);
        if (execution && options.allow.length && peers.length) {
          if (!repo) return null; // Read Git outside the lock, then check the current board again before registering.
          for (const worker of peers) {
            const shared = [...new Set([...repo.files.filter(file => matches(options.allow, file) && matches(worker.allow, file)), ...options.allow.filter(glob => worker.allow.includes(glob))])];
            if (shared.length) throw new Error(`Scope overlaps "${worker.title}" (pid ${worker.pid}; board "${worker.boardFile}"): ${shared.slice(0, 3).join(', ')}`);
          }
        }
        const agreed = history.findLast(entry => entry.type === 'meeting' && entry.agent === options.agent && entry.session === options.resume);
        if (execution && options.allow.length && !options.meeting && !options.skipMeeting) {
          const problem = !agreed ? 'no meeting for the session' : agreed.status !== 'confirmed' ? 'roundtable not confirmed'
            : history.some(entry => entry.type === 'consolidate' && entry.meeting === agreed.meeting) ? `roundtable ${agreed.meeting} is closed`
            : !sameScope(options.allow, agreed.allow || []) ? 'scope differs from the one agreed' : null;
          if (problem) throw new Error(`${problem}; hold a roundtable with --meeting <id> (same --allow), then --resume its session for the build, or pass --skip-meeting <reason>; see --help`);
        }
        if (options.meeting) {
          if (history.some(entry => entry.type === 'consolidate' && entry.meeting === options.meeting)) throw new Error(`Meeting ${options.meeting} is closed; use a new --meeting id`);
          const pending = [...pendingMeetings(history)].find(meeting => meeting !== options.meeting);
          if (pending) throw new Error(`Meeting ${pending} is not consolidated; run node "${helper}" consolidate --cwd "${options.cwd}" --meeting ${pending} --summary <file.md>`);
        }
        const prior = options.resume && history.findLast(entry => entry.type === 'meeting' && entry.agent === options.agent && entry.session === options.resume
          && entry.meeting === options.meeting && entry.status === 'understood' && Object.values(fields).every(key => entry.understanding?.[key]));
        const admitted = { meeting: options.meeting || agreed?.meeting || null, phase: prior ? 'confirmation' : 'understanding', repo };
        const entry = { id, pid: process.pid, title: options.title, role: options.role, agent: options.agent, model: options.model,
          cwd: options.cwd, allow: options.allow, meeting: admitted.meeting, startedAt: Date.now() };
        const temporary = path.join(this.board, id + '.tmp');
        fs.writeFileSync(temporary, JSON.stringify(entry));
        fs.renameSync(temporary, path.join(this.board, id + '.json'));
        if (options.skipMeeting) this.append({ type: 'skip', id, title: options.title, session: options.resume || null, agent: options.agent,
          model: options.model, reason: options.skipMeeting });
        return admitted;
      });
      if (admission) return admission;
      repo = repoFiles(options.cwd);
      if (!repo) throw new Error('Cannot verify repository files for team scope admission');
    }
  }
  release(id) {
    for (const extension of ['.json', '.tmp']) fs.rmSync(path.join(this.board, id + extension), { force: true });
  }
  context(id, before) {
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
    return [`# Project memory\n\n${this.memory}\nRead it whole if needed.\n\n${memoryExcerpt(read(this.memory))}`,
      `# Working now\n\n${working || '- none'}`,
      `# Repository\n\n${lines.slice(0, 40).join('\n') || '(clean)'}${lines.length > 40 ? `\n… and ${lines.length - 40} more` : ''}\n\n${log || '(no commits)'}`];
  }
  async finish(options, report) {
    return this.locked(() => {
      recordFindings({ ...options, memory: this.memory }, report.answer, report.header);
      this.append({ type: 'end', id: report.id, title: String(options.title || '').slice(0, 240), session: report.session || options.resume || null,
        meeting: report.meeting || options.meeting || null, role: options.meeting ? '圆桌' : options.role, kind: report.kind ?? null, model: report.model || 'unreported',
        reason: report.reason, outputTokens: nonnegative(report.outputTokens) ? report.outputTokens : null,
        activeMs: nonnegative(report.activeMs) ? report.activeMs : null });
      if (options.meeting) {
        const parsed = report.phase === 'confirmation' ? confirmationOf(report.answer) : understandingOf(report.answer);
        const status = report.reason === 'exit' ? parsed.status : 'invalid';
        this.append({ type: 'meeting', id: report.id, meeting: options.meeting, session: report.session || options.resume || null,
          agent: options.agent, model: report.model, role: options.role, title: options.title, allow: options.allow, ...parsed, status });
        return { status };
      }
      return { status: null };
    });
  }
  minutes(meeting, issues = [], language = 'zh') {
    if (!Array.isArray(issues) || issues.some(issue => !issue || ISSUE_KEYS.some(key => typeof issue[key] !== 'string'))) {
      throw new Error('Issues must be an array of { issue, raisedBy, answer, result } strings');
    }
    language = language === 'en' ? 'en' : 'zh';
    const t = LABELS[language];
    const history = this.entries(), entries = history.filter(entry => entry.type === 'meeting' && entry.meeting === meeting);
    if (!entries.length) throw new Error(`No roundtable records for ${meeting}`);
    // Only matching task identities replace sessionless failures; workers with sessions remain separate.
    const tasks = new Map();
    for (const entry of entries) {
      const failed = JSON.stringify([entry.title, entry.agent, [...new Set(entry.allow || [])].sort()]);
      const key = entry.session ? JSON.stringify([entry.agent, entry.session]) : failed, previous = tasks.get(key);
      if (entry.session) tasks.delete(failed);
      tasks.set(key, { understanding: entry.understanding ? entry : previous?.understanding,
        latest: entry.session ? entry : { ...entry, status: 'invalid' } });
    }
    const rows = [...tasks.values()].map(({ understanding, latest }) => {
      const entry = understanding || latest;
      const open = latest.status === 'open' ? latest.confirmation?.questions || [] : [];
      const row = { who: [entry.model, entry.role].filter(Boolean).join(' · '), title: entry.title,
        ...Object.fromEntries(Object.values(fields).map(key => [key, entry.understanding?.[key] || ''])), status: latest.status, open };
      if (open.length) row.questions = [blank(row.questions) ? '' : row.questions, ...open.map(question => t.openPrefix + question)].filter(Boolean).join('\n');
      return row;
    });
    return { meeting, round: this.round(history, meeting), generatedAt: Date.now(), language, rows, issues };
  }
  round(history, meeting) { return [...new Set(history.filter(entry => entry.type === 'meeting').map(entry => entry.meeting))].indexOf(meeting) + 1; }
  async consolidate(meeting, summary, records = {}) {
    const entries = roundRecords(records);
    if (!/^### Results[ \t]*\r?$/m.test(summary) || !/^### Architecture changes[ \t]*\r?$/m.test(summary)) {
      throw new Error('Summary must contain ### Results and ### Architecture changes');
    }
    return this.locked(() => {
      const history = this.entries(), round = this.round(history, meeting);
      if (!round) throw new Error(`No roundtable records for ${meeting}`);
      const running = this.live().filter(entry => entry.meeting === meeting);
      if (running.length) throw new Error(`Meeting ${meeting} still has live workers: ${running.map(entry => entry.title).join(', ')}`);
      fs.appendFileSync(this.memory, `\n\n## Round ${round} · ${meeting} · ${stamp(Date.now())}\n\n${summary.trim()}\n`);
      for (const entry of entries) this.append({ ...entry, meeting });
      this.append({ type: 'consolidate', meeting });
    });
  }
}

// The same minutes as Markdown, with the page's labels: the brief of the confirmation runs and the lead's tables.
function minutesMarkdown(minutes) {
  const t = minutes.language === 'en' ? LABELS.en : LABELS.zh;
  const cell = value => {
    if (blank(value)) return '—';
    return (Array.isArray(value) ? value.join('\n') : String(value)).trim().replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
      .replace(/[\\|`*_[\]]/g, '\\$&').replace(/\r?\n/g, '<br>');
  };
  const table = (headings, rows) => [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
  const rows = minutes.rows.map(row => [cell(row.who), `**${cell(row.title)}**<br>${cell(row.goal)}`,
    ...['files', 'provides', 'uses', 'doneWhen', 'questions'].map(key => cell(row[key])), cell(statusWord(t, row.status))]);
  const issues = minutes.issues.map(issue => ISSUE_KEYS.map(key => cell(issue[key])));
  const confirmed = minutes.rows.filter(row => row.status === 'confirmed').length;
  return `# ${t.round(minutes.round)} · ${cell(minutes.meeting)}\n\n${stamp(minutes.generatedAt)}\n\n`
    + table(t.columns, rows) + '\n\n' + table(t.issueColumns, issues) + `\n\n${t.summary(confirmed, minutes.rows.length)}\n`;
}

module.exports = { projectTeam, understandingOf, confirmationOf, meetingRequest, memoryExcerpt, recordFindings, minutesMarkdown, FINDINGS };
