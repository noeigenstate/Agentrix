const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const filename = path.join(__dirname, '../src/features/agents/RoutingReview.tsx');
const sourceModule = new Module(filename, module);
sourceModule.filename = filename;
sourceModule.paths = Module._nodeModulePaths(path.dirname(filename));
const originalRequire = sourceModule.require.bind(sourceModule);
sourceModule.require = id => id === '../../shared/i18n' ? {
  t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (pattern, key) => values[key] ?? pattern),
} : originalRequire(id);
sourceModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
const { RoutingReview, resolveRouting } = sourceModule.exports;
const action = () => {};
const flags = ['expensive-model', 'fast-on', 'high-effort', 'unlisted-model', 'verification-weakened', 'custom-text', 'operation-cost'];
const foreign = {
  layer: 'local', state: 'pending', remote: false, path: '.agentrix/routing.json', digest: 'seen-file', actions: ['apply', 'keep', 'overwrite'],
  raw: '{"custom":"<script>never execute</script>"}',
  review: {
    digest: 'seen-file', reason: 'new-on-machine',
    config: { roles: { 'x-writer': { from: 'developer', name: 'Writer', duty: '<script>never execute</script>', outputs: '<b>Plain output</b>' } }, operations: {} },
    changes: [
      { role: 'x-writer', field: 'enabled', from: false, to: true },
      { role: 'x-writer', field: 'fresh', from: true, to: false },
      { operation: 'lookup', field: 'model', from: 'haiku', to: 'opus' },
    ],
    flags: flags.map(code => ({ code, text: 'Reported ' + code })), ignored: ['roles.unknown', 'roles.frontend.seat'],
  },
};
const render = (source, props = {}) => renderToStaticMarkup(React.createElement(RoutingReview, {
  source, busy: false, act: action, rawOpen: false, toggleRaw: action, ...props,
}));

test('routing review shows every change, flag and custom text as plain text', () => {
  const html = render(foreign, { rawOpen: true });
  assert.match(html, /首次在此电脑打开/);
  assert.match(html, /\.agentrix\/routing\.json/);
  assert.match(html, /当前使用：本机项目设置/);
  assert.match(html, /启用.*新实例.*lookup.*haiku.*opus/);
  for (const code of flags) {
    assert.ok(html.includes(`data-routing-flag="${code}"`));
    assert.ok(html.includes('Reported ' + code));
  }
  assert.match(html, /roles\.unknown.*roles\.frontend\.seat/);
  assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;Plain output&lt;\/b&gt;/);
  assert.match(html, /<pre[^>]*id="routing-raw"/);
  assert.doesNotMatch(html, /<script>|<b>Plain output/);
  const changed = render({ ...foreign, layer: 'accepted', review: { ...foreign.review, reason: 'changed' } });
  assert.match(changed, /文件在 Agentrix 之外被修改/);
  assert.match(changed, /当前使用：上次接受的配置/);
  assert.doesNotMatch(changed, /<pre/);
});

test('invalid and rejected routing show only main’s allowed actions and readable raw text', () => {
  const { review, ...source } = foreign;
  const link = { ...source, raw: undefined, state: 'invalid', actions: ['keep'], error: { code: 'link', message: 'code wins' } };
  const html = render(link);
  assert.match(html, /路由路径是链接/);
  assert.match(html, /data-routing-action="keep"/);
  assert.doesNotMatch(html, /data-routing-action="(?:apply|overwrite)"|查看原文|忽略的条目/);
  const invalid = { ...link, raw: 'not JSON', actions: ['keep', 'overwrite'], error: { code: 'bad-json', message: '' } };
  assert.match(render(invalid, { rawOpen: true }), /JSON 无效.*not JSON.*data-routing-action="overwrite"/);
  const rejected = { ...invalid, state: 'rejected', actions: [] };
  assert.doesNotMatch(render(rejected), /data-routing-action=/);
});

test('routing actions send the rendered digest and refuse actions absent from the source', async () => {
  const calls = [];
  const api = { resolveSkillRouting: async (...args) => { calls.push(args); return { ok: true }; } };
  for (const verb of ['apply', 'keep', 'overwrite']) {
    await resolveRouting(api, 'project-1', foreign, verb);
  }
  assert.equal(resolveRouting(api, 'project-1', { ...foreign, actions: ['keep'] }, 'apply'), undefined);
  assert.equal(resolveRouting(api, 'project-1', { ...foreign, digest: null }, 'overwrite'), undefined);
  assert.deepEqual(calls, ['apply', 'keep', 'overwrite'].map(verb => ['project-1', verb, 'seen-file']));
});
