// The oss task source: curated SWE-bench Verified Python tasks, run natively. Until its task manifest ships the source
// says so and offers nothing; every other call is rejected.
const waiting = ctx => Promise.reject(new Error(ctx.t('等待任务清单')));

function createOssSource() {
  return {
    id: 'oss', review: 'diff',
    async describe(ctx) {
      return {
        id: 'oss', available: false, reason: ctx.t('等待任务清单'), metric: 'resolved', review: true,
        size: { min: 1, max: 20, standard: 5 }, options: [], manifest: null, published: null, downloadBytes: null, keyStored: null,
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

module.exports = { createOssSource };
