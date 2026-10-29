// Development memory handed from one CLI to the next in the same folder. Claude Code and Codex each remember only their
// own conversations, so a new session of either starts knowing nothing of the work done here before. When one starts,
// the folder's permanent memory (project-memory.cjs) is brought up to date and its latest rounds are written down for
// it, with where the whole history is; the startup note (startupNote) tells it to read this before its first reply, so
// the person does nothing to carry the work over. Kept in Agentrix's own data, never in the project.
const fs = require('node:fs/promises');
const path = require('node:path');
const { gather, writeMemoryBook, renderRound, forAgents } = require('./project-memory.cjs');
const { MAX_NOTE, plain, skillInstructions } = require('../skills/delivery.cjs');

const ROUND_LIMIT = 12, FILE_LIMIT = 48 * 1024;

// The handoff for a CLI starting in a folder, from its memory (folder as the memory names it; label as the CLI knows
// it), or null when nothing was ever done there. withBook: name the whole memory's file, which only a CLI on this
// computer can open.
async function handoffText(memoryDir, folder, label = folder, withBook = true) {
  const { file: book, rounds } = await writeMemoryBook(memoryDir, folder);
  if (!rounds.length) return null;
  let text = `# Earlier work in this folder\n\nFolder: ${label}\nWritten by Agentrix when this session started: the latest ${Math.min(ROUND_LIMIT, rounds.length)} of ${rounds.length} rounds `
    + `worked here with Claude Code or Codex, newest first. If one is from the conversation you are resuming, you already have it.\n`
    + (withBook ? `The whole history is kept in ${book.replace(/\\/g, '/')}: read it when the work needs more than this.\n` : '') + '\n';
  for (const round of rounds.slice(-ROUND_LIMIT).reverse()) {
    const part = renderRound(round) + '\n';
    if (Buffer.byteLength(text + part) > FILE_LIMIT) { text += '…\n'; break; }
    text += part;
  }
  return text;
}

// Writes the handoff for a CLI starting in cwd, or removes it when nothing was ever done here.
async function writeHandoff(file, cwd, { memoryDir, codexHome, claudeHome } = {}) {
  await gather(memoryDir, cwd, { codexHome, claudeHome });
  const text = await handoffText(memoryDir, cwd);
  if (!text) { await fs.rm(file, { force: true }); return false; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, forAgents(text), 'utf8');
  return true;
}

// The note both CLIs get at start: what the reading view shows; for a local folder, where its handoff is; and the
// project's skills, how they grow and that they carry nothing personal. Paths are written with forward slashes: the
// note travels inside a TOML string to Codex, where a backslash escapes. It holds no double quote or line break.
function startupNote(readingNote, file, skills, delivery = null) {
  // The homework card shows these three parts first (src/features/home/delivery.ts); the labels are what it reads.
  let note = `${readingNote} When you finish a task, end your reply with a delivery summary for the user to grade: a line 【交付】, then for a fix three lines 问题：(the problem solved) 原因：(its specific cause) 结果：(the outcome and how it was verified), `
    + 'or for an optimization three lines 优化：(what was optimized) 解决：(the problem it solves) 对比：(before and after, with numbers when measured). One or two plain sentences each, with these labels exactly.';
  if (file) note += ` Before your first reply in this session, read the file ${file.replace(/\\/g, '/')} if it exists: `
    + 'it is the recent development work done in this same folder with Claude Code or Codex (what was asked, answered, changed and run), '
    + 'which the user expects you to know and continue from without being told. Do not mention reading it unless asked.';
  if (skills) note += ` This project keeps its skills in ${skills.replace(/\\/g, '/')} (a folder per skill holding a SKILL.md that starts with name and description front matter). `
    + 'When you take on a task, look there and follow the skills whose description fits. When the work shows a procedure, convention or lesson that will come up again in this project, '
    + 'create or update a skill there: short, specific, and tested. Skills are committed to the repository and shared, so never write personal or private data into them: '
    + 'no names of people, email addresses, phone numbers, user names, home folder paths, host names or IP addresses, passwords, tokens or keys; write placeholders such as <home>, <user>, <host> or <secret> instead.';
  if (!delivery) return plain(note);
  const instructions = skillInstructions(delivery);
  // Large libraries travel by manifest, never as skill bodies in an environment variable/command line.
  // The manifest contains the full always/auto list and every editing permission, with no entries dropped.
  const suffix = note.length + instructions.length + 1 <= MAX_NOTE ? instructions
    : `Before any task, read and follow ${delivery.manifest}. It lists all enabled always/auto skills, installed agents and skill editing permissions.`;
  return plain(`${note} ${suffix}`);
}

module.exports = { writeHandoff, handoffText, startupNote };
