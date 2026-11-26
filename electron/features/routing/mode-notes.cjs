const plain = value => String(value || '').replace(/\\/g, '/').replace(/"/g, "'").replace(/[\x00-\x1f\x7f]+/g, ' ');

const NATIVE_MODE = 'Agentrix runs this session in native mode: you are the plain CLI conversation you were born as and do what you always did, the tasks yourself. '
  + 'Conductor mode is off, so the team roles are unavailable: do not dispatch them.';
const conductorMode = remote => 'Agentrix runs this session in conductor mode: forget how you used to work. You are this project\'s conductor, with a team of roles to call, '
  + 'and your aim is to get every task done fast and well through them; the routing guide says how. '
  + 'Read needsDecision from role_result. Decide each listed question and continue or restart the role with your decision. '
  + 'Ask the owner only about irreversible or outward-facing actions '
  + '(such as publishing, sending or deleting) or product decisions they have not delegated. Ask once with options and a recommendation. '
  + (remote ? 'SSH roles have no interactive menu for answer_role. '
    : 'When a role waits on a question or plan menu, decide and answer with answer_role, following the same rules for asking the owner. ')
  + 'Claude roles can run commands and tests. They must never commit, push, or run git reset --hard. Read-only roles must leave project files untouched. '
  + 'Let the role decide whether to run tests and which task-related tests to run. '
  + 'For each needsApproval entry in role_result, do the refused action yourself if allowed, or ask the owner once and restart the role with a wider allowance if approved.';

// What a running session is told when the owner switches its mode: the mode itself and, for a conductor, its instructions.
function modeNote(conductor, guidePath, remote = false) {
  const roles = conductor && guidePath ? ` Before your next step, read and follow ${guidePath}; start roles with the start_role tool.` : '';
  const text = conductor ? conductorMode(remote) : NATIVE_MODE;
  const reopen = conductor && remote ? ' If this SSH conversation was opened in native mode, reopen it to connect the role tools.' : '';
  return plain(`Agentrix: the owner has just switched this conversation's mode, which replaces the mode you were told before. ${text}${roles}${reopen}`);
}

function launchNote({ conductor, remote, guidePath }) {
  return conductor ? plain(conductorMode(remote) + (guidePath ? ' Before any task, read and follow ' + guidePath + '.' : '')) : NATIVE_MODE;
}

// The seat table a conductor conversation runs with now, replacing the one it read when it started.
function routingChangeNote(table) {
  return plain(`Agentrix: the owner changed model routing. These seats replace the ones you were told before, including the table in the routing guide: ${table}. `
    + 'Agentrix will try to switch this session to the orchestrator seat. Check the CLI for the active model, effort, and fast mode.');
}

module.exports = { plain, launchNote, modeNote, routingChangeNote };
