const fs = require('node:fs');
const path = require('node:path');
const { readText, folderSignature } = require('./files.cjs');

const SKILL_FOLDERS = ['skills', '.claude/skills', '.codex/skills'];
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const projectSkillTargets = project => [...SKILL_FOLDERS, ...INSTRUCTION_FILES].map(relative => path.join(project.path, relative));

function projectSkillNames(project, builtinPaths = []) {
  const names = new Map();
  const add = (name, relative, agents) => {
    const copies = names.get(name) || {};
    for (const agent of agents) copies[agent] ||= relative;
    names.set(name, copies);
  };
  for (const relative of SKILL_FOLDERS) {
    const root = path.join(project.path, relative);
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        try {
          if (entry.isDirectory() || entry.isSymbolicLink() && fs.statSync(path.join(root, entry.name), { throwIfNoEntry: false })?.isDirectory()) {
            add(entry.name, `${relative}/${entry.name}/SKILL.md`, relative === 'skills' ? ['claude', 'codex'] : [relative.slice(1).split('/')[0]]);
          }
        } catch { /* Skip an unreadable link without hiding its siblings. */ }
      }
    } catch { /* Project references are optional, including broken or inaccessible symlinks. */ }
  }
  for (const relative of INSTRUCTION_FILES) {
    try {
      let text = (readText(path.join(project.path, relative)) || '').replace(/\\/g, '/');
      // An instruction pointing at Agentrix's own copy is not a project override.
      for (const file of builtinPaths) {
        const escaped = file.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), '');
      }
      for (const word of text.match(/[\p{L}\p{N}_-]+/gu) || []) add(word, relative, relative === 'CLAUDE.md' ? ['claude'] : ['claude', 'codex']);
    } catch { /* Never surface optional project instruction files as settings errors. */ }
  }
  return names;
}

async function projectSkillSignature(target) {
  if (!INSTRUCTION_FILES.includes(path.basename(target))) return folderSignature(target);
  try {
    const stat = await fs.promises.stat(target);
    return JSON.stringify([stat.mode, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino]);
  } catch (error) { return error.code || error.message; }
}

module.exports = { projectSkillTargets, projectSkillNames, projectSkillSignature };
