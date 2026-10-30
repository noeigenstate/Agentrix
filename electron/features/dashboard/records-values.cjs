const path = require('node:path');

const text = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const route = value => ({ model: text(value?.model) || 'unreported', effort: text(value?.effort, 32), fast: typeof value?.fast === 'boolean' ? value.fast : null });
const projectName = project => (project.kind === 'ssh' ? path.posix : path).basename(project.path);

function runRecord(project, call, event) {
  const actual = call.unconfirmed ? route(null) : route(event);
  const declared = call.declared || call.unconfirmed ? route(call.declared || call) : null;
  const mismatch = declared && Object.keys(actual).some(key => actual[key] !== null && actual[key] !== 'unreported' && actual[key] !== declared[key]);
  const verdict = call.unconfirmed ? 'unverified' : event.verdict || (mismatch ? 'mismatch' : actual.model === 'unreported' ? 'unverified' : 'ok');
  return { id: text(event.id), projectId: text(project.id), project: text(projectName(project), 240),
    agent: call.sourceAgent, ...actual, ...(declared ? { declared } : {}), role: text(call.role, 32), kind: call.kind ?? null,
    title: text(call.title, 240), meeting: text(call.meeting, 64), skipMeeting: text(call.skipMeeting, 240),
    startedAt: number(call.startedAt), endedAt: number(event.endedAt), activeMs: number(event.activeMs),
    outputTokens: count(event.outputTokens), inputTokens: count(event.inputTokens), cachedTokens: count(event.cachedTokens),
    reportedCostUsd: number(event.reportedCostUsd), reason: text(event.reason, 32),
    exitCode: Number.isSafeInteger(event.exitCode) ? event.exitCode : null, outOfScope: count(event.outOfScopeCount) ?? event.outOfScope?.length ?? 0, verdict };
}

function gradeRecord(grade, project, session) {
  const keys = ['projectId', 'terminalId', 'outcome', 'submission', 'note'];
  if (!grade || typeof grade !== 'object' || Array.isArray(grade) || Object.keys(grade).some(key => !keys.includes(key)) ||
    !['projectId', 'terminalId'].every(key => typeof grade[key] === 'string' && grade[key].length > 0 && grade[key].length <= 160 && !/[\x00-\x1f\x7f]/.test(grade[key])) ||
    !['passed', 'sent-back'].includes(grade.outcome) || count(grade.submission) === null || grade.submission < 1 ||
    grade.note !== undefined && typeof grade.note !== 'string') throw new Error('无效的交付评分。');
  if (!session || project?.id !== grade.projectId || session.projectId !== project.id || session.terminalId !== grade.terminalId) {
    throw new Error('评分终端与项目不匹配。');
  }
  return { projectId: grade.projectId, project: text(projectName(project), 240), terminalId: grade.terminalId,
    agent: ['codex', 'claude'].includes(session.agent) ? session.agent : null,
    model: text(session.agentSettings?.model), effort: text(session.agentSettings?.effort, 32),
    sessionId: text(session.agent === 'claude' ? session.claudeSessionId || session.claudeResumeId || session.sessionId
      : session.rootThreadId || session.reportedThreadId || session.sessionId),
    outcome: grade.outcome, submission: grade.submission,
    ...(grade.outcome === 'sent-back' && grade.note !== undefined ? { note: grade.note.slice(0, 2000) } : {}) };
}

function quotaWindows(limits) {
  if (!Array.isArray(limits)) return [];
  return limits.filter(value => value && number(value.percent) !== null).slice(0, 16)
    .map(value => ({ minutes: number(value.minutes), percent: value.percent, resetsAt: number(value.resetsAt) }))
    .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
}

module.exports = { runRecord, gradeRecord, quotaWindows };
