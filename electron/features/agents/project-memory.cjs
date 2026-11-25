// Each project folder's development memory, kept by Agentrix for good. Claude Code and Codex each keep only their own
// records, and Claude Code clears its transcripts after a month; this keeps every round either of them worked in the
// folder (what was asked, what it answered, which files changed, which checks ran) in this profile, never in the
// project, and never removes one. It is filled from their records when a CLI starts there and from the live
// conversation when a round ends (SSH projects too), and is what the handoff to the next CLI is made from.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { records } = require('../../session-files.cjs');
const { ConversationLog } = require('../../conversation.cjs');
const { adapters, adapterOf } = require('../cli-adapters/registry.cjs');

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
  try { text = await fs.readFile(archiveFile(dir, folder), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rounds = new Map();
  for (const line of text.split('\n')) { try { const round = JSON.parse(line); if (round?.key) rounds.set(round.key, round); } catch { } }
  return [...rounds.values()].sort((a, b) => a.at - b.at);
}

// Adds rounds, or a round's later state (its reply arrived, more files changed); one writer per folder at a time.
const writing = new Map();
function serialize(file, action) {
  const next = (writing.get(file) || Promise.resolve()).catch(() => {}).then(action).finally(() => {
    if (writing.get(file) === next) writing.delete(file);
  });
  writing.set(file, next);
  return next;
}
async function writeAtomically(file, text) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
function remember(dir, folder, rounds) {
  if (!rounds.length) return Promise.resolve(0);
  const file = archiveFile(dir, folder);
  return serialize(file, async () => {
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
    await writeAtomically(file, sorted.map(round => JSON.stringify(round)).join('\n') + '\n');
    await fs.writeFile(path.join(dir, `${folderKey(folder)}.folder.txt`), folder, 'utf8');
    return changed;
  });
}

async function conversation(agent, filename, cwd) {
  const log = new ConversationLog(() => {}, 4000, { pictures: false });
  const { conversation: take } = adapterOf(agent).transcript;
  for await (const record of records(filename, { historyWindow: true })) { try { take(log, record, cwd); } catch { } }
  return log.list;
}

// Every conversation both CLIs had in this folder, read again only when its file changed since the last look.
const looked = new Map();
async function gather(dir, cwd, homes = {}) {
  const sources = [];
  for (const { manifest: { id: agent }, transcript } of adapters()) {
    if (!transcript?.list) continue;
    for (const source of await transcript.list(cwd, homes[`${agent}Home`])) sources.push({ ...source, agent });
  }
  const rounds = [];
  for (const source of sources) {
    let stat; try { stat = await fs.stat(source.filename); } catch { continue; }
    const mark = `${stat.size}:${stat.mtimeMs}`;
    const previous = looked.get(source.filename);
    if (previous !== mark) rounds.push(...roundsOf(await conversation(source.agent, source.filename, cwd).catch(() => []), source.agent, source.id));
    looked.delete(source.filename);
    looked.set(source.filename, mark);
    if (looked.size > 10000) looked.delete(looked.keys().next().value);
  }
  return remember(dir, cwd, rounds);
}

// The whole memory as Markdown, newest first, for an agent that needs to look further back than the handoff.
function renderRound(round) {
  const name = adapterOf(round.agent)?.manifest.label ?? adapterOf('claude').manifest.label;
  const lines = [`### ${new Date(round.at).toLocaleString('zh-CN', { hour12: false })} · ${name}`, '', `**User:** ${round.ask}`];
  if (round.reply) lines.push(`**${name}:** ${round.reply}`);
  if (round.files?.length) lines.push(`Changed: ${round.files.join(', ')}`);
  if (round.checks?.length) lines.push(`Checks: ${round.checks.join(', ')}`);
  return lines.join('\n') + '\n';
}
// Text an agent reads with its own tools. On Windows they read it through PowerShell 5.1, whose Get-Content takes a
// file without a byte-order mark for the system code page (GBK on a Chinese system) and turns every Chinese word into
// garbage; with the mark it reads UTF-8.
const forAgents = text => (process.platform === 'win32' ? '\uFEFF' : '') + text;
function writeMemoryBook(dir, folder) {
  return serialize(archiveFile(dir, folder), async () => {
    const rounds = await readArchive(dir, folder), file = path.join(dir, `${folderKey(folder)}.md`);
    await fs.mkdir(dir, { recursive: true });
    const text = forAgents(`# Development memory of ${folder}\n\nEvery round worked in this folder with Claude Code or Codex, newest first. Kept by Agentrix.\n\n`
      + rounds.slice().reverse().map(renderRound).join('\n'));
    const previous = await fs.readFile(file, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (previous !== text) await writeAtomically(file, text);
    return { file, rounds };
  });
}

module.exports = { folderKey, roundsOf, readArchive, remember, gather, writeMemoryBook, renderRound, forAgents };
