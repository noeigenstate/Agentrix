const fs = require('node:fs');
const path = require('node:path');
const { readText, folderSignature } = require('./files.cjs');

const SKILL_FOLDERS = ['skills', '.claude/skills', '.codex/skills'];
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const projectSkillTargets = project => [...SKILL_FOLDERS, ...INSTRUCTION_FILES].map(relative => path.join(project.path, relative));

function projectSkillNames(project, report) {
  const names = new Set();
  for (const relative of SKILL_FOLDERS) {
    const root = path.join(project.path, relative);
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name);
    } catch (error) { report(error); }
  }
  for (const relative of INSTRUCTION_FILES) {
    try {
      const text = readText(path.join(project.path, relative)) || '';
      for (const word of text.match(/[\p{L}\p{N}_-]+/gu) || []) names.add(word);
    } catch (error) { report(error); }
  }
  return names;
}

async function projectSkillSignature(target) {
  if (!INSTRUCTION_FILES.includes(path.basename(target))) return folderSignature(target);
  try {
    const stat = await fs.promises.lstat(target);
    return JSON.stringify([stat.mode, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino]);
  } catch (error) { return error.code || error.message; }
}

module.exports = { projectSkillTargets, projectSkillNames, projectSkillSignature };
