const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { aborted } = require('./process.cjs');
const { MODELS, TASK_KINDS } = require('./values.cjs');
const { modelKey } = require('../dashboard/cost.cjs');

const CLAUDE_LOGIN_ERROR = '无法登录 Claude';

async function claudeLoginFailed(result, out) {
  const login = new RegExp([
    'authentication_error', 'invalid_api_key', 'not logged in',
    'authentication (?:failed|error)', '(?:failed|unable) to (?:authenticate|log in|sign in)',
    '(?:please|must) (?:run |use )?(?:/login|claude auth login)',
    '(?:oauth|refresh token).*(?:expired|invalid)', 'unauthorized.*401',
  ].join('|'), 'i');
  if (login.test(result.stdout + '\n' + result.stderr)) return true;
  let file;
  try {
    file = await fs.open(out + '.log', 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return login.test(buffer.toString('utf8', 0, bytesRead));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { await file?.close(); }
}

function workerArguments({ arm, cwd, brief, out, helper, kind = 'core', review = false }) {
  const codex = arm === 'sol' && !review;
  const mode = codex ? ['--fast'] : ['--permission', review ? 'plan' : 'acceptEdits'];
  const scope = review ? [] : [
    '--allow', '**', '--skip-meeting', 'Isolated lab baseline; the orchestrated lead holds its own worker roundtable.',
  ];
  return [
    helper, codex ? 'codex' : 'claude', '--role', review ? '审查' : '执行',
    '--title', review ? 'Blind change review' : 'Implement the requested change',
    '--model', review ? MODELS.opus : MODELS[arm], '--effort', codex ? 'max' : 'high', ...mode,
    '--cwd', cwd, '--brief', brief, '--out', out,
    '--kind', review ? 'review' : TASK_KINDS.includes(kind) ? kind : 'core', ...scope,
  ];
}

function taskBrief(task, arm, helper, runDirectory, control = path.join(runDirectory, 'control')) {
  const rules = [
    'Work only in the isolated project and its worktrees under ' + runDirectory + '.',
    'Write all plans, minutes, ledgers, reviews and coordination notes under ' + control + ', outside the project.',
    'Never commit, push, release, run CI, edit SKILL.md or launch a desktop app.',
    'Do not inspect other experiments, reference material, grading files or hidden tests.',
    'Use clear names and simple control flow. Remove duplication and follow the project code standard.',
    'Run appropriate existing Node unit tests and report their actual results.',
    'Use Node and this dispatch entrypoint for every model invocation: ' + helper,
    'Quote paths for your shell. GPT: gpt-6.1-sol --effort max --fast.',
    'Claude: Opus/Sonnet 5.5 --effort high --permission acceptEdits; use plan for read-only reviews.',
    'Every editing worker needs --allow for its disjoint module paths. Use real brief files and keep outputs under control.',
    'Only the lead may dispatch the planned workers. Those workers must never delegate further.',
  ];
  const pipeline = [
    'You are the Opus 5.5 lead. Follow skills/model-routing/SKILL.md with this experiment taking precedence.',
    'Run the full pipeline: an Opus module plan; a roundtable where every worker restates and confirms the plan;',
    'Sol builds complex code/debugging in worktree A; Sonnet handles routine/front-end/tests in worktree B;',
    'integrate diffs without commits and test; an independent Opus architecture review and fresh Sonnet acceptance;',
    'fix confirmed findings, then consolidate the round journal. Pick a fresh meeting id.',
    'Use the dispatch entrypoint above for all workers so their usage and phases are measured.',
    'Record review findings and fixed status in the consolidation findings JSON. Keep roles and kinds accurate.',
    'Do not wait for owner approval. Omit UI driving when there is no UI. Finish with changes in this starting worktree.',
  ];
  const single = [
    'Solve the task yourself as a single model. Do not delegate or invoke other models.',
    'Do not run the model-routing workflow. This single-model condition overrides repository routing instructions.',
  ];
  return [...rules, '', ...(arm === 'orchestrated' ? pipeline : single), '', '# Task', '', task.text, ''].join('\n');
}

async function dispatch({ arm, cwd, directory, session, usage, signal, timeoutMs, task, review = false, briefText }) {
  aborted(signal);
  const prefix = review ? 'review' : 'worker';
  const control = session
    ? review ? path.join(cwd, '.control') : path.join(session.control, randomUUID()) : directory;
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  const brief = path.join(control, prefix + '-brief.md'), out = path.join(control, prefix + '-answer.md');
  const helper = session?.publicHelper;
  await fs.writeFile(brief, briefText || taskBrief(task, arm, helper, session?.workspaceRoot, session?.control), { mode: 0o600 });
  aborted(signal);
  if (!session) throw new Error('A trusted isolated lab session is required.');
  let mismatch = false, reportedModel = null;
  try {
    const args = workerArguments({ arm, cwd, brief, out, helper, kind: task?.kind, review });
    const result = await session.root(args.slice(1), {
      cwd, review, timeoutMs, log: path.join(directory, prefix + '.log'),
      onLine(line) {
        const ended = /^\[dispatch\] ended [\w-]+ (?:codex|claude) model (\S+)/.exec(line);
        if (ended) reportedModel = ended[1];
        if (/^\[dispatch\].*routing MISMATCH/.test(line)) { mismatch = true; session.controller.abort(); }
      },
    });
    const failed = /\bOUT OF SCOPE:|\[dispatch\] failed to start| · exit -?\d+ reason (?:error|scope|unconfirmed|capacity|killed)/;
    if (result.code !== 0 || failed.test(result.stdout)) {
      if ((review || arm !== 'sol') && await claudeLoginFailed(result, out)) throw new Error(CLAUDE_LOGIN_ERROR);
      throw new Error('实验模型执行失败，请查看运行日志。');
    }
    const call = [...usage.calls.values()].findLast(call => call.cwd === cwd && call.role === (review ? '审查' : '执行'));
    const actual = reportedModel || call?.model;
    if (!actual || actual === 'unreported' || modelKey(actual) !== MODELS[review ? 'opus' : arm]) {
      throw new Error('实验模型与指定方案不匹配。');
    }
    const answer = await fs.readFile(out, 'utf8');
    await fs.copyFile(out, path.join(directory, prefix + '-answer.md'));
    await fs.copyFile(brief, path.join(directory, prefix + '-brief.md'));
    return { ...result, answer };
  } catch (error) {
    if (mismatch) throw new Error('实验模型与指定方案不匹配。');
    throw error;
  }
}

module.exports = { dispatch, workerArguments, taskBrief, claudeLoginFailed, CLAUDE_LOGIN_ERROR };
