const path = require('node:path');
const os = require('node:os');
const { handoffText } = require('../features/agents/handoff.cjs');
const { remember, roundsOf } = require('../features/agents/project-memory.cjs');
const { scrubSkills } = require('../features/agents/skill-privacy.cjs');
const { ConversationLog, claudeConversation, codexConversation } = require('../conversation.cjs');

function createProjectHandoff({ app, getStore, sessions }) {
  // Each local terminal's handoff of earlier work, and every folder's permanent development memory, in this profile
  // (never in the project; the memory is never cleared).
  const handoffFile = terminalId => path.join(app.getPath('userData'), 'handoff', `${terminalId}.md`);
  const memoryDir = () => path.join(app.getPath('userData'), 'memory');
  // The folder a session works in, as the memory names it: its path here, or the SSH host and path.
  const memoryFolder = (project, s) => project.kind === 'ssh' ? `ssh://${project.ssh?.host}${getStore().findTerminal(s.terminalId)?.record.restore?.cwd || project.path}`
    : getStore().findTerminal(s.terminalId)?.record.restore?.cwd || project.path;
  // Skills the agents write into a project are committed and pushed: whatever personal data got into them (this
  // computer's home folder and user name, the SSH hosts, addresses, keys, contacts) is replaced as soon as a round ends.
  async function scrubProjectSkills(project) {
    const changed = await scrubSkills(path.join(project.path, 'skills'), { homes: [os.homedir()], users: [os.userInfo().username],
      hosts: getStore().projects.filter(item => item.kind === 'ssh' && item.ssh?.host).map(item => item.ssh.host) });
    if (changed.length) console.log(`Agentrix scrubbed personal data from ${changed.length} skill file(s) in ${project.name}.`);
    return changed;
  }
  // Over SSH the conversations lie on that computer: its worker sends the folder's latest ones (compacted), which join
  // the memory kept here, and the handoff made from the memory is written back there for the CLI that starts, at the
  // path its startup note names (integration/remote-worker.py).
  async function sshHandoff(project, s) {
    if (!s.terminal?.request) return;
    const folder = memoryFolder(project, s), cwd = getStore().findTerminal(s.terminalId)?.record.restore?.cwd || project.path;
    const history = await s.terminal.request('history', {}), rounds = [];
    for (const [agent, read] of [['codex', codexConversation], ['claude', claudeConversation]]) {
      for (const session of Array.isArray(history?.[agent]) ? history[agent] : []) {
        const log = new ConversationLog(() => {}, 2000);
        for (const record of Array.isArray(session.records) ? session.records : []) { try { read(log, record, cwd); } catch { } }
        rounds.push(...roundsOf(log.list, agent, String(session.id || '')));
      }
    }
    await remember(memoryDir(), folder, rounds);
    if (sessions.get(s.terminalId) !== s) return;
    await s.terminal.request('write-handoff', { text: await handoffText(memoryDir(), folder, cwd, false) || '' });
  }
  return { handoffFile, memoryDir, memoryFolder, scrubProjectSkills, sshHandoff };
}

module.exports = { createProjectHandoff };
