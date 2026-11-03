const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { folderSignature } = require('./files.cjs');

const SKILL_FOLDERS = ['skills', '.claude/skills', '.codex/skills'];
const projectSkillTargets = project => SKILL_FOLDERS.map(relative => path.join(project.path, relative));
const linkedSkillParent = target => ['.claude', '.codex'].includes(path.basename(path.dirname(target)))
  && !!fs.lstatSync(path.dirname(target), { throwIfNoEntry: false })?.isSymbolicLink();

async function projectSkillSignature(target) {
  try { return linkedSkillParent(target) ? 'linked parent' : await folderSignature(target); }
  catch (error) { return error.code || error.message; }
}

function replaceProjectSkills(project, names, dataDir, failures, report) {
  const replaced = [];
  const reportOnce = (file, error) => { if (!failures.has(file)) { failures.add(file); report(error); } };
  for (const relative of SKILL_FOLDERS) {
    // Never follow a linked parent into storage outside the project.
    let root = project.path;
    try {
      for (const part of relative.split('/')) {
        root = path.join(root, part);
        const stat = fs.lstatSync(root, { throwIfNoEntry: false });
        if (!stat?.isDirectory() || stat.isSymbolicLink()) { root = null; break; }
      }
    } catch (error) { reportOnce(root, error); continue; }
    if (!root) continue;
    for (const name of names) {
      const from = path.join(root, name);
      try {
        const stat = fs.lstatSync(from, { throwIfNoEntry: false });
        if (!stat || !stat.isDirectory() && !stat.isSymbolicLink()) { failures.delete(from); continue; }
        const at = Date.now(), stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
        const parent = path.join(dataDir, 'skill-replaced', createHash('sha256').update(project.id).digest('hex').slice(0, 32));
        for (const folder of [dataDir, path.dirname(parent), parent]) {
          if (fs.lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Invalid skill backup folder');
        }
        fs.mkdirSync(parent, { recursive: true });
        let backup = path.join(parent, `${name}-${stamp}`), suffix = 0;
        while (fs.lstatSync(backup, { throwIfNoEntry: false })) backup = path.join(parent, `${name}-${stamp}-${++suffix}`);
        // rename moves a junction/symlink itself, including a broken link, without touching its target.
        try { fs.renameSync(from, backup); }
        catch (error) {
          if (error.code !== 'EXDEV') throw error;
          fs.cpSync(from, backup, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
          if (stat.isSymbolicLink()) fs.unlinkSync(from);
          else fs.rmSync(from, { recursive: true });
        }
        replaced.push({ project: project.name, name, from: `${relative}/${name}`, backup: path.resolve(backup), at });
        failures.delete(from);
      } catch (error) {
        reportOnce(from, error);
      }
    }
  }
  return replaced;
}

function extensionBase(name, names) {
  return [...names].sort((a, b) => b.length - a.length).find(base => name.startsWith(`${base}-`)
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.slice(base.length + 1))) || null;
}

module.exports = { projectSkillTargets, replaceProjectSkills, projectSkillSignature, linkedSkillParent, extensionBase };
