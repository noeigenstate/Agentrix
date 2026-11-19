const path = require('node:path');
const { realpath } = require('node:fs/promises');

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && path.isAbsolute(left) && path.isAbsolute(right)
  && (process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right));
const validScope = allow => Array.isArray(allow) && allow.length <= 256 && allow.every(glob => typeof glob === 'string' && glob.length > 0 && glob.length <= 1024
  && !/^(?:[A-Za-z]:|[\\/~])|(?:^|[\\/])\.\.(?:[\\/]|$)|[\0\r\n]/.test(glob));

// Main supplies the current terminal, project and asynchronous team lookup; credentials never enter the run binding.
async function resolveRegistration({ sessions, store, locateTeam, operations }, registration) {
  const session = sessions.get(registration.projectId), project = store.findTerminal(registration.projectId)?.project;
  const refusal = () => {
    if (!session || !project || sessions.get(registration.projectId) !== session || !registration.sessionKey || session.sessionKey !== registration.sessionKey
      || store.findTerminal(registration.projectId)?.project !== project) return 'dispatch.session_mismatch';
    if (!registration.capability || session.controlCapability !== registration.capability) return 'dispatch.control_unbound';
    return null;
  };
  let refused = refusal();
  if (refused) return { refused };
  const leadMode = () => session.agent === 'claude' ? session.nativeStructured ? 'native' : 'terminal' : 'codex';
  const refuse = code => {
    const auth = refusal();
    return auth ? { refused: auth } : { refused: code, leadMode: leadMode() };
  };
  if (typeof registration.cwd !== 'string' || !path.isAbsolute(registration.cwd) || !['claude', 'codex'].includes(registration.agent)
    || !validScope(registration.allow) || typeof registration.readOnly !== 'boolean' || typeof registration.roundtable !== 'boolean') return refuse('dispatch.control_unbound');
  const [location, parent] = await Promise.all([locateTeam(registration.cwd, { details: true }), locateTeam(project.path, { details: true })]);
  refused = refusal();
  if (refused) return { refused };
  let worker;
  if (location?.status === 'outside_git') {
    if (registration.roundtable === true) return refuse('dispatch.control_unbound');
    let cwd, projectRoot;
    try { [cwd, projectRoot] = await Promise.all([realpath(registration.cwd), realpath(project.path)]); }
    catch { return refuse('dispatch.project_mismatch'); }
    const relative = path.relative(cwd, projectRoot);
    // A boardless ancestor would let a relative glob reach into the project without its admission lock.
    if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return refuse('dispatch.project_mismatch');
    worker = { id: registration.runId, agent: registration.agent, cwd: registration.cwd, allow: registration.allow,
      readOnly: registration.readOnly === true || registration.allow.length === 0 };
  } else {
    if (!['found', 'no_team'].includes(location?.status) || !['found', 'no_team'].includes(parent?.status)
      || !samePath(location.common, parent.common)) return refuse('dispatch.project_mismatch');
    try { worker = location.team?.live().find(run => run.id === registration.runId); }
    catch { return refuse('dispatch.unknown_run'); }
    if (!worker) return refuse('dispatch.unknown_run');
    if (worker.agent !== registration.agent || !samePath(worker.cwd, registration.cwd) || !validScope(worker.allow)) return refuse('dispatch.control_unbound');
  }
  refused = refusal();
  if (refused) return { refused };
  const local = project.kind !== 'ssh';
  const levers = local ? operations?.(project.id, session.skillSessionId || session.sessionId) : null;
  const workerOperations = worker.agent === 'codex' ? { codexConfig: levers?.codex.config } : { claudeOperationEnv: levers?.claude.env };
  return { run: { runId: worker.id, projectId: registration.projectId, agent: worker.agent, cwd: worker.cwd, worktree: worker.cwd,
    allow: [...worker.allow], readOnly: worker.readOnly === true || worker.role === '调查' || worker.role === '审查' || registration.readOnly === true,
    roundtable: worker.role === '圆桌' || registration.roundtable === true, local, leadMode: leadMode(), ...(levers && workerOperations) } };
}

module.exports = { resolveRegistration };
