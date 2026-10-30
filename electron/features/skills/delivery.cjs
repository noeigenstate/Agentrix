const MAX_NOTE = 6000;
const SSH_REFERENCE_NOTE = 'Shipped built-in and global skills are read-only reference copies for this SSH session, contain SKILL.md text only, and are deleted when it ends.';
const plain = value => String(value || '').replace(/\\/g, '/').replace(/"/g, "'").replace(/[\x00-\x1f\x7f]+/g, ' ');

function skillInstructions({ skills, yielded = [], globalFolder, agents, pendingPath, remote = false, skippedNote = '' }) {
  const enabled = skills.filter(skill => skill.enabled), parts = [];
  parts.push(remote ? '{AGENTRIX_AGENTS}' : `Installed agents: Claude Code ${agents?.claude?.installed ? 'installed' : 'missing'}; Codex ${agents?.codex?.installed ? 'installed' : 'missing'}.`);
  for (const skill of enabled.filter(skill => skill.trigger === 'always')) parts.push(`Before any task, read and follow ${skill.path}${skill.firstRun ? '; this is its first run in this project' : ''}.`);
  for (const skill of enabled.filter(skill => skill.trigger === 'first-open')) parts.push(`Before the first task of this session, read and follow ${skill.path}; this is its first run in this project.`);
  const auto = enabled.filter(skill => skill.trigger === 'auto');
  if (auto.length) parts.push(`Available auto skills: ${auto.map(skill => `${skill.name}: ${skill.description} (${skill.path})`).join('; ')}; read each one whose description fits before starting.`);
  for (const { name, path } of yielded) parts.push(`This project has its own ${name} skill at ${path}; follow it.`);
  parts.push(`Global user skills folder: ${globalFolder}.`);
  if (remote) parts.push(SSH_REFERENCE_NOTE);
  if (skippedNote) parts.push(skippedNote);
  for (const skill of enabled.filter(skill => !remote && skill.source === 'user')) {
    parts.push(`${skill.path}: ${!skill.autoOptimize ? 'must not change it' : skill.confirmChanges
      ? `propose edits only to ${pendingPath(skill)}; do not change the active file until the user accepts`
      : 'may update it in place with short, specific, tested improvements'}.`);
  }
  const disabled = skills.filter(skill => skill.scope === 'project' && !skill.enabled);
  if (disabled.length) parts.push(`Project skills: do not use these: ${disabled.map(skill => skill.name).join(', ')}.`);
  parts.push('Built-in skills are read-only. Never write personal or private data into any skill: use placeholders for names, emails, phones, user names, home paths, hosts, IPs, passwords, tokens and keys.');
  return plain(parts.join(' '));
}

module.exports = { MAX_NOTE, SSH_REFERENCE_NOTE, plain, skillInstructions };
