// The aa task source: Terminal-Bench 4.0 tasks in Docker ("AA 同款"). Until its task manifest ships the source says so
// and offers nothing; every other call is rejected.
const waiting = ctx => Promise.reject(new Error(ctx.t('等待任务清单')));

function createAaSource() {
  return {
    id: 'aa', review: 'none',
    async describe(ctx) {
      return {
        id: 'aa', available: false, reason: ctx.t('等待任务清单'), metric: 'tests', review: false,
        size: { min: 1, max: 66, standard: 10 }, options: [], manifest: null, published: null, downloadBytes: null, keyStored: null,
      };
    },
    async sample() { return []; },
    canonical: (selection, ctx) => waiting(ctx),
    guard: (scope, ctx) => waiting(ctx),
    reference: (task, scope, ctx) => waiting(ctx),
    prepare: (task, scope, ctx) => waiting(ctx),
    grade: (task, scope, ctx) => waiting(ctx),
  };
}

module.exports = { createAaSource };
