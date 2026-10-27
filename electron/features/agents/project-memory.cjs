// Each project folder's development memory, kept by Agentrix for good. Claude Code and Codex each keep only their own
// records, and Claude Code clears its transcripts after a month; this keeps every round either of them worked in the
// folder (what was asked, what it answered, which files changed, which checks ran) in this profile, never in the
// project, and never removes one. It is filled from their records when a CLI starts there and from the live
// conversation when a round ends (SSH projects too), and is what the handoff to the next CLI is made from.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { records, rolloutFiles, sessionMeta } = require('../../session-files.cjs');
const { interactiveSession } = require('../../session-restore.cjs');
const { claudeConfigDir, findClaudeSession, listClaudeSessions } = require('../../claude-sessions.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../../conversation.cjs');

const TEXT_LIMIT = 4000, CHECKS = new Set(['运行测试', '检查类型', '构建项目', '检查代码格式']);

// A folder's name in the archive: its path (case-folded on Windows), or for SSH the account, host and path.
function folderKey(folder) {
  const name = /^ssh:\/\//.test(folder) ? folder : process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);
  return crypto.createHash('sha1').update(name).digest('hex').slice(0, 20);
}
const archiveFile = (dir, folder) => path.join(dir, `${folderKey(folder)}.jsonl`);

// A conversation's entries as rounds: each ask, its last reply, the files it wrote and the checks it ran. Notices the
// CLI puts in the user's place ("<task-notification>…") are not asks.
function roundsOf(entries, agent, session) {
  const result = [];
  for (const entry of entries) {
    if (entry.role === 'user' && !entry.answer && !entry.queued && entry.text && !entry.text.trim().startsWith('<')) {
      const at = Number(entry.at) || 0;
      result.push({ key: `${agent}:${session}:${crypto.createHash('sha1').update(`${at}\n${entry.text}`).digest('hex').slice(0, 16)}`, agent, session, at, ask: entry.text.slice(0, TEXT_LIMIT), reply: '', files: [], checks: [] });
    }
    const round = result.at(-1);
    if (!round) continue;
    if (entry.role === 'assistant' && entry.text) round.reply = entry.text.slice(0, TEXT_LIMIT);
    else if (entry.role === 'tool' && entry.tool) {
      for (const file of entry.tool.written || []) if (!round.files.includes(file) && round.files.length < 40) round.files.push(file);
      const check = CHECKS.has(entry.tool.phrase) ? `${entry.tool.phrase}${entry.tool.failed ? '（失败）' : ''}` : '';
      if (check && !round.checks.includes(check)) round.checks.push(check);
    }
  }
  return result;
}

async function readArchive(dir, folder) {
  let text = '';
  try { text = await fs.readFile(archiveFile(dir, folder), 'utf8'); } catch { return []; }
  const rounds = new Map();
  for (const line of text.split('\n')) { try { const round = JSON.parse(line); if (round?.key) rounds.set(round.key, round); } catch { } }
  return [...rounds.values()].sort((a, b) => a.at - b.at);
}

// Adds rounds, or a round's later state (its reply arrived, more files changed); one writer per folder at a time.
const writing = new Map();
function remember(dir, folder, rounds) {
  if (!rounds.length) return Promise.resolve(0);
  const file = archiveFile(dir, folder), previous = writing.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const known = new Map((await readArchive(dir, folder)).map(round => [round.key, round]));
    let changed = 0;
    for (const round of rounds) {
      const old = known.get(round.key), merged = { ...old, ...round };
      if (old && JSON.stringify(old) === JSON.stringify(merged)) continue;
      known.set(round.key, merged); changed++;
    }
    if (!changed) return 0;
    await fs.mkdir(dir, { recursive: true });
    const sorted = [...known.values()].sort((a, b) => a.at - b.at);
    await fs.writeFile(`${file}.tmp`, sorted.map(round => JSON.stringify(round)).join('\n') + '\n', 'utf8');
    await fs.rename(`${file}.tmp`, file);
    await fs.writeFile(path.join(dir, `${folderKey(folder)}.folder.txt`), folder, 'utf8');
    return changed;
  });
  writing.set(file, next);
  return next;
}

async function conversation(agent, filename, cwd) {
  const log = new ConversationLog(() => {}, 4000);
  const take = agent === 'claude' ? claudeConversation : codexConversation;
  for await (const record of records(filename, { historyWindow: true })) { try { take(log, record, cwd); } catch { } }
  return log.list;
}

// Every conversation both CLIs had in this folder, read again only when its file changed since the last look.
const looked = new Map();
async function gather(dir, cwd, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), claudeHome = claudeConfigDir() } = {}) {
  const sources = [];
  for (const session of await listClaudeSessions(cwd, null, claudeHome).catch(() => [])) {
    const filename = await findClaudeSession(cwd, session.id, claudeHome).catch(() => null);
    if (filename) sources.push({ agent: 'claude', id: session.id, filename });
  }
  const files = (await rolloutFiles(path.join(codexHome, 'sessions')).catch(() => [])).sort((a, b) => b.modified - a.modified).slice(0, 3000);
  for (const file of files) {
    try { const meta = await sessionMeta(file.filename); if (interactiveSession(meta, cwd)) sources.push({ agent: 'codex', id: meta.id, filename: file.filename }); } catch { }
  }
  const rounds = [];
  for (const source of sources) {
    let stat; try { stat = await fs.stat(source.filename); } catch { continue; }
    const mark = `${stat.size}:${stat.mtimeMs}`;
    if (looked.get(source.filename) === mark) continue;
    rounds.push(...roundsOf(await conversation(source.agent, source.filename, cwd).catch(() => []), source.agent, source.id));
    looked.set(source.filename, mark);
  }
  return remember(dir, cwd, rounds);
}

// The whole memory as Markdown, newest first, for an agent that needs to look further back than the handoff.
function renderRound(round) {
  const name = round.agent === 'codex' ? 'Codex' : 'Claude Code', lines = [`### ${new Date(round.at).toLocaleString('zh-CN', { hour12: false })} · ${name}`, '', `**User:** ${round.ask}`];
  if (round.reply) lines.push(`**${name}:** ${round.reply}`);
  if (round.files?.length) lines.push(`Changed: ${round.files.join(', ')}`);
  if (round.checks?.length) lines.push(`Checks: ${round.checks.join(', ')}`);
  return lines.join('\n') + '\n';
}
// Text an agent reads with its own tools. On Windows they read it through PowerShell 5.1, whose Get-Content takes a
// file without a byte-order mark for the system code page (GBK on a Chinese system) and turns every Chinese word into
// garbage; with the mark it reads UTF-8.
const forAgents = text => (process.platform === 'win32' ? '\uFEFF' : '') + text;
async function writeMemoryBook(dir, folder) {
  const rounds = await readArchive(dir, folder), file = path.join(dir, `${folderKey(folder)}.md`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, forAgents(`# Development memory of ${folder}\n\nEvery round worked in this folder with Claude Code or Codex, newest first. Kept by Agentrix.\n\n${rounds.slice().reverse().map(renderRound).join('\n')}`), 'utf8');
  return { file, rounds };
}

module.exports = { folderKey, roundsOf, readArchive, remember, gather, writeMemoryBook, renderRound, forAgents };
