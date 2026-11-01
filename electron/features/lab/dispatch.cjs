const fs = require('node:fs/promises');
const path = require('node:path');
const { command, aborted } = require('./process.cjs');
const { MODELS, TASK_KINDS } = require('./values.cjs');
const { modelKey } = require('../dashboard/cost.cjs');

function workerArguments({ arm, cwd, brief, out, helper, kind = 'core', review = false }) {
  const codex = arm === 'sol' && !review;
  return [helper, codex ? 'codex' : 'claude', '--role', review ? '审查' : '执行', '--title', review ? 'Blind change review' : 'Implement the requested change',
    '--model', review ? MODELS.opus : MODELS[arm], '--effort', codex ? 'max' : 'high', ...(codex ? ['--fast'] : ['--permission', review ? 'plan' : 'acceptEdits']),
    '--cwd', cwd, '--brief', brief, '--out', out, '--kind', review ? 'review' : TASK_KINDS.includes(kind) ? kind : 'core',
    ...(review ? [] : ['--allow', '**', '--skip-meeting', 'An isolated Virtual Lab comparison; the orchestrated arm holds its own worker roundtable.'])];
}

function taskBrief(task, arm, helper, runDirectory) {
  const rules = `Work only in this isolated experiment repository and its worktrees under ${runDirectory}.
Never edit the owner's original project, dependency links, files outside this run, or SKILL.md files. Never commit, push, release, run CI or launch a desktop app.
Do not inspect reference commits, later history, Git alternates, the experiment data, grading files or hidden tests. Implement only the task below from this starting tree.
Keep code simple and idiomatic, remove duplication, use clear control flow and names, and follow the project's code standard. Run appropriate existing Node unit tests; never invent a passing result.
Use Node and this dispatch helper file for every model worker: ${helper}. Pass paths as arguments and quote them for your shell. GPT: gpt-6.1-sol --effort max --fast. Claude: opus/sonnet 5.5 --effort high --permission acceptEdits (plan for read-only reviews).
The helper's --brief must be a real file, --out must be within this run, --cwd must be an isolated worktree, and every editing worker needs --allow for its disjoint module paths. No worker may delegate further.`;
  const route = arm === 'orchestrated' ? `You are the Opus 5.5 lead. Follow skills/model-routing/SKILL.md, with this experiment's constraints taking precedence.
Run the full pipeline: an Opus module plan; a roundtable where every worker restates the whole plan and confirms the minutes; GPT-6.1-Sol builds complex code/debugging in worktree A; Sonnet 5.5 handles routine/front-end/tests in worktree B; integrate and test; an independent Opus architecture review and fresh Sonnet interaction/behaviour acceptance; fix confirmed findings; consolidate the round journal.
Use the dispatch helper for all those invocations so their usage and phase evidence is recorded. Pick a fresh meeting id. Keep worker worktrees under this run; integrate their diffs without commits. Do not wait for owner approval in this unattended experiment.
Record review findings and whether each was fixed in the consolidation findings JSON, using the helper's format. Keep phase roles/kinds accurate. Omit UI driving when there is no UI to accept. Finish with the implemented changes in this starting worktree.`
    : `Solve the task yourself as a single model. Do not delegate, invoke other models, or run the project's model-routing workflow. This single-model condition takes precedence over repository routing instructions.`;
  return `${rules}\n\n${route}\n\n# Task\n\n${task.text}\n`;
}

async function dispatch({ arm, cwd, directory, helper, nodePath = process.execPath, env, usage, signal, timeoutMs, task, review = false, briefText }) {
  aborted(signal);
  const prefix = review ? 'review' : 'worker', brief = path.join(directory, `${prefix}-brief.md`), out = path.join(directory, `${prefix}-answer.md`);
  await fs.writeFile(brief, briefText || taskBrief(task, arm, helper, path.dirname(cwd)), { mode: 0o600 });
  const control = new AbortController(), abort = () => control.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) control.abort();
  let mismatch = false, reportedModel = null;
  try {
    const result = await command(nodePath, workerArguments({ arm, cwd, brief, out, helper, kind: task?.kind, review }), {
      cwd, env: { ...env, ELECTRON_RUN_AS_NODE: '1', AGENTRIX_BOOTSTRAP: usage.bootstrap }, signal: control.signal, timeoutMs,
      log: path.join(directory, `${prefix}.log`), onLine(line) {
        usage.line(line);
        const ended = /^\[dispatch\] ended [\w-]+ (?:codex|claude) model (\S+)/.exec(line);
        if (ended) reportedModel = ended[1];
        if (/^\[dispatch\].*routing MISMATCH/.test(line)) { mismatch = true; control.abort(); }
      },
    });
    if (result.code !== 0 || /\bOUT OF SCOPE:|\[dispatch\] failed to start| · exit -?\d+ reason (?:error|scope|unconfirmed|capacity|killed)/.test(result.stdout)) throw new Error('实验模型执行失败，请查看运行日志。');
    const call = [...usage.calls.values()].findLast(call => call.cwd === cwd && call.role === (review ? '审查' : '执行'));
    const actual = reportedModel || call?.model;
    if (!actual || actual === 'unreported' || modelKey(actual) !== MODELS[review ? 'opus' : arm]) throw new Error('实验模型与指定方案不匹配。');
    return { ...result, answer: await fs.readFile(out, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) };
  } catch (error) {
    if (mismatch) throw new Error('实验模型与指定方案不匹配。');
    throw error;
  } finally { signal.removeEventListener('abort', abort); }
}

module.exports = { dispatch, workerArguments, taskBrief };
