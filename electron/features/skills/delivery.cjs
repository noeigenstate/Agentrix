const MAX_NOTE = 6000;
const SSH_REFERENCE_NOTE = 'Shipped built-in and global skills are read-only reference copies containing SKILL.md text only. The current bundle survives closed terminals for resume. Other bundles and receipts older than 30 days are pruned on the next SSH terminal start.';
const plain = value => String(value || '').replace(/\\/g, '/').replace(/"/g, "'").replace(/[\x00-\x1f\x7f]+/g, ' ');

const NATIVE_MODE = 'Agentrix runs this session in native mode: you are the plain CLI conversation you were born as and do what you always did, the tasks yourself. Conductor mode is off, so the team roles are unavailable: do not dispatch them.';
const CONDUCTOR_MODE = 'Agentrix runs this session in conductor mode: forget how you used to work. You are this project\'s conductor, with a team of roles to call, '
  + 'and your aim is to get every task done fast and well through them; the model-routing skill says how. '
  + 'For ## Needs decision, decide and continue or restart the role with your decision. Ask the owner only about irreversible or outward-facing actions '
  + '(such as publishing, sending or deleting) or product decisions they have not delegated. Ask once with options and a recommendation. '
  + 'When a role waits on a question or plan menu, decide and answer with answer_role, asking the owner only under the same rules as ## Needs decision. '
  + 'For ## Needs approval, do the refused action yourself if allowed, or ask the owner once and restart the role with a wider allowance if approved.';

// What a running session is told when the owner switches its mode: the mode itself and, for a conductor, its instructions.
function modeNote(conductor, routingSkill) {
  const roles = conductor && routingSkill ? ` Before your next step, read and follow ${routingSkill}; start roles with the start_role tool.` : '';
  return plain(`Agentrix: the owner has just switched this conversation's mode, which replaces the mode you were told before. ${conductor ? CONDUCTOR_MODE : NATIVE_MODE}${roles}`);
}

function skillInstructions({ skills, globalFolder, agents, pendingPath, remote = false, skippedNote = '', routingNote = '', conductor = false }) {
  const enabled = skills.filter(skill => skill.enabled), parts = [];
  parts.push(conductor ? CONDUCTOR_MODE : NATIVE_MODE);
  parts.push(remote ? '{AGENTRIX_AGENTS}' : `Installed agents: Claude Code ${agents?.claude?.installed ? 'installed' : 'missing'}; Codex ${agents?.codex?.installed ? 'installed' : 'missing'}.`);
  for (const skill of enabled) {
    if (skill.trigger === 'always') parts.push(`Before any task, read and follow ${skill.path}${skill.firstRun ? '; this is its first run in this project' : ''}.`);
    else if (skill.firstOpenRun && skill.firstRun) parts.push(`Before the first task of this session, read and follow ${skill.path}; this is its first run in this project.`);
    else parts.push(`Available auto skills: ${skill.name}: ${skill.description} (${skill.path}); read it when its description fits before starting.`);
    if (skill.extends) parts.push(`For ${skill.name}, follow ${skill.extends} first, then this extension's additions; where they conflict, the system skill wins.`);
  }
  parts.push(`Global user skills folder: ${globalFolder}.`);
  parts.push('When creating a user skill, never reuse a built-in name: name an extension <builtin-name>-<id>, where <id> matches [a-z0-9]+(-[a-z0-9]+)*.');
  parts.push('Claude receives skill updates after compact or clear; Codex receives updated instructions at its next launch.');
  if (remote) parts.push(SSH_REFERENCE_NOTE);
  if (skippedNote) parts.push(skippedNote);
  if (routingNote) parts.push(routingNote);
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

module.exports = { MAX_NOTE, SSH_REFERENCE_NOTE, plain, skillInstructions, modeNote };
