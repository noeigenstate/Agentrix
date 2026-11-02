// The contract between the lab engine and a task source (history, oss, aa). It requires nothing, so the engine and the
// providers can both load it. A provider is a plain object; from the engine it imports this file only, and it reaches the
// machine only through ctx (its tools, cache folder and, in a run, the sandboxed session). Grading material (gold patches, hidden test contents) lives only in ctx.cacheDirectory or the owner's own
// git: never in the app bundle, a task, a workspace before grading, or the page.
//
// Errors a provider throws carry one of three meanings:
//   error.infrastructure = true  the machine failed (disk, download, Docker); never blacklists the task
//   error.fatal = true           isolation was breached or the owner's project changed; stops every lane
//   anything else                the task is rejected (reference) or the run is an error (grade): never a pass

/** @typedef {import('../../../../src/shared/lab-types').LabSource} LabSource */
/** @typedef {import('../../../../src/shared/lab-types').LabArm} LabArm */
/** @typedef {import('../../../../src/shared/lab-types').LabTask} LabTask */
/** @typedef {import('../../../../src/shared/lab-types').LabSourceInfo} LabSourceInfo */
/** @typedef {import('../../../../src/shared/lab-types').LabSampleQuery} LabSampleQuery */
/** @typedef {import('../../../../src/shared/lab-types').LabSelection} LabSelection */

/**
 * @typedef {object} ProviderContext
 * @property {AbortSignal} signal
 * @property {(source: string, values?: object) => string} t   translate a Chinese phrase into the owner's language
 * @property {string} cacheDirectory   <userData>/lab/cache/<source>: private to this source, sandbox-denied, persists
 * @property {typeof import('./tools.cjs')} tools
 * @property {() => { id: string, name: string, path?: string, kind?: string }[]} getProjects
 * @property {NodeJS.Platform} platform
 * @property {() => string | null} credential   the owner's key for this source (aa's AA API key), else null; never store or log it
 */

/**
 * @typedef {object} LabSessionLike
 * @property {(file: string, args: string[], options: { cwd: string, timeoutMs?: number, log?: string, network?: boolean })
 *   => Promise<{ code: number | null, stdout: string, stderr: string }>} execute   sandboxed; network defaults to false
 * @property {string} nodePath
 */

/**
 * ctx plus the run's own folders and sandboxed session. reference() gets it with reference: null.
 * @typedef {ProviderContext & {
 *   workspaceRoot: string, artifactDirectory: string, session: LabSessionLike, testTimeoutMs: number, reference: Reference | null,
 * }} RunContext
 */

/**
 * canonical()'s answer. scope is opaque to the engine and handed back to every later call; scopeKey identifies the
 * scope across experiments (reference blacklist = source + scopeKey); scopeLabel is shown as the lane's scope.
 * @typedef {{ scope: unknown, scopeKey: string, scopeLabel: string, tasks: LabTask[] }} Canonical
 */

/**
 * protectedPaths join the session's protected paths; check() throws an error with fatal: true when what it guards changed.
 * @typedef {{ protectedPaths: string[], check(): Promise<void> }} Guard
 */

/**
 * The grader proven on the known answer before any model runs. JSON-serialisable; diffFiles are the paths captureDiff
 * keeps even when they look like notes (the answer's own files).
 * @typedef {{ diffFiles: string[], [key: string]: unknown }} Reference
 */

/** @typedef {{ cwd: string, baseline: string, real: string, gitDirectory: string, files: string[] }} Workspace */

/**
 * task replaces the task text under "# Task" in the dispatched brief; rules are extra lines for the brief's rules.
 * @typedef {{ task: string, rules: string[] }} Brief
 */

/**
 * score is 0..1 on the source's own scale; evidence is the main log's path inside runCtx.artifactDirectory, or null.
 * @typedef {{ testsPassed: number | null, testsTotal: number | null, score: number | null, passed: boolean,
 *   evidence: string | null }} Grade
 */

/**
 * @typedef {object} LabSourceProvider
 * @property {LabSource} id
 * @property {'diff' | 'none'} review   'diff': the change gets today's blind review
 * @property {Partial<Record<LabArm, { minutes: number, costUsd: number }>>} [defaults]   per-arm estimate before any record
 * @property {(ctx: ProviderContext) => Promise<LabSourceInfo>} describe   cheap, no network; the engine maps a throw to unavailable
 * @property {(query: LabSampleQuery, ctx: ProviderContext) => Promise<LabTask[]>} sample   no network, deterministic
 * @property {(selection: LabSelection, ctx: ProviderContext) => Promise<Canonical>} canonical   rebuilds tasks; an unknown id throws
 * @property {(scope: unknown, ctx: ProviderContext) => Promise<void>} [fetch]   downloads pinned data into cacheDirectory
 * @property {(scope: unknown, ctx: ProviderContext) => Promise<Guard>} guard
 * @property {(task: LabTask, scope: unknown, runCtx: RunContext) => Promise<Reference>} reference
 * @property {(task: LabTask, scope: unknown, runCtx: RunContext) => Promise<Workspace>} prepare   inside runCtx.workspaceRoot
 * @property {(task: LabTask, scope: unknown) => Brief} [brief]
 * @property {(task: LabTask, scope: unknown, runCtx: RunContext) => Promise<Grade>} grade   a throw is a run error
 */

const LAB_SOURCES = Object.freeze(['history', 'oss', 'aa']);
const LAB_ARMS = Object.freeze(['orchestrated', 'opus', 'sol', 'sonnet']);
// History ids stay bare commits; other sources prefix their own name.
const TASK_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64}|(?:oss|aa)-[a-z0-9][a-z0-9-]{0,94})$/;
const REQUIRED = ['describe', 'sample', 'canonical', 'guard', 'reference', 'prepare', 'grade'];
const OPTIONAL = ['fetch', 'brief'];

// Unique across sources: references, blacklists and runs are keyed by it.
const taskKey = task => task.source + ':' + task.id;

/** @returns {LabSourceProvider} */
function assertProvider(provider) {
  const fail = detail => { throw new TypeError(`Invalid lab source provider${provider?.id ? ' ' + provider.id : ''}: ${detail}.`); };
  if (!provider || typeof provider !== 'object') fail('not an object');
  if (!LAB_SOURCES.includes(provider.id)) fail('unknown id');
  if (!['diff', 'none'].includes(provider.review)) fail('review must be diff or none');
  for (const name of REQUIRED) if (typeof provider[name] !== 'function') fail(name + ' is missing');
  for (const name of OPTIONAL) if (provider[name] !== undefined && typeof provider[name] !== 'function') fail(name + ' is not a function');
  if (provider.defaults !== undefined) {
    const entries = provider.defaults && typeof provider.defaults === 'object' ? Object.entries(provider.defaults) : null;
    if (!entries || entries.some(([arm, value]) => !LAB_ARMS.includes(arm) ||
      !(Number.isFinite(value?.minutes) && value.minutes > 0 && Number.isFinite(value.costUsd) && value.costUsd >= 0))) {
      fail('defaults must map arms to positive minutes and nonnegative costUsd');
    }
  }
  return provider;
}

module.exports = { LAB_SOURCES, LAB_ARMS, TASK_ID, taskKey, assertProvider };
