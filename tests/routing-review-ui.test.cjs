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
sourceModule.require = id => {
  if (id === '../../shared/i18n') return { t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (pattern, key) => values[key] ?? pattern) };
  return originalRequire(id);
};
sourceModule._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
const { RoutingReview, resolveRouting } = sourceModule.exports;
const action = () => {};
const flags = ['expensive-model', 'fast-on', 'high-effort', 'unlisted-model', 'custom-text'];
const writer = { name: 'Writer', duty: '<script>never execute</script>', outputs: '<b>Plain output</b>' };
const active = { model: 'opus', effort: 'high', fast: true, fresh: false, enabled: true };
const foreign = {
  layer: 'local', state: 'pending', remote: false, path: '.agentrix/routing.json', digest: 'seen-file', actions: ['apply', 'keep', 'overwrite'],
  raw: '{"custom":"<script>never execute</script>"}',
  review: {
    digest: 'seen-file', reason: 'new-on-machine',
    config: { roles: { 'x-writer': { from: 'developer', name: 'Writer', duty: '<script>never execute</script>', outputs: '<b>Plain output</b>' } } },
    roleChanges: [
      { role: 'x-writer', source: 'custom', status: 'added', before: null, after: { ...active, custom: writer } },
      { role: 'x-old', source: 'custom', status: 'removed', before: { ...active, custom: { ...writer, name: 'Retired' } }, after: null },
      { role: 'developer', source: 'builtin', status: 'changed', before: active, after: { ...active, effort: 'max' } },
    ],
    flags: [...flags.map(code => ({ code, role: 'x-writer' })),
      { code: 'high-effort', role: 'reviewer' }],
    ignored: ['roles.unknown', 'roles.frontend.seat'],
  },
};
const render = (source, props = {}) => renderToStaticMarkup(React.createElement(RoutingReview, {
  source, busy: false, act: action, rawOpen: false, toggleRaw: action,
  roles: [{ id: 'developer', name: '开发' }, { id: 'reviewer', name: '审查' }], ...props,
}));

test('routing review shows every change, flag and custom text as plain text', () => {
  const html = render(foreign, { rawOpen: true });
  assert.match(html, /首次在此电脑打开/);
  assert.match(html, /\.agentrix\/routing\.json/);
  assert.match(html, /当前使用：本机项目设置/);
  assert.match(html, /<th scope="col">角色<\/th>/);
  assert.match(html, /新增角色.*移除或停用的角色.*修改的角色/s);
  assert.equal((html.match(/data-review-role=/g) ?? []).length, 3);
  assert.match(html, /<tr data-review-role="x-writer" data-risk="true">[^]*?<dt>名称<\/dt><dd>Writer<\/dd>[^]*?&lt;b&gt;Plain output&lt;\/b&gt;[^]*?<\/tr>/);
  assert.match(html, /<tr data-review-role="x-old">[^]*?Retired[^]*?&lt;b&gt;Plain output&lt;\/b&gt;[^]*?<\/tr>/);
  assert.match(html, /<tr data-review-role="developer">[^]*?开发<\/span>[^]*?developer[^]*?<div class="seats-review-settings"><span>强度 <span>high<\/span> → <span>max<\/span><\/span><\/div>/);
  for (const code of flags) {
    assert.ok(html.includes(`data-routing-flag="${code}"`));
    assert.ok(html.includes('data-routing-risk-count="' + code + '"'));
  }
  assert.match(html, /data-routing-risk-count="high-effort">[^<]* × 2/);
  assert.match(html, /seats-review-other-risks"[^]*?审查<\/span>/);
  assert.match(html, /class="seats-review-ignored"><h4>忽略的条目<\/h4>.*roles\.unknown.*roles\.frontend\.seat/);
  assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;Plain output&lt;\/b&gt;/);
  assert.match(html, /<pre[^>]*id="routing-raw"/);
  assert.doesNotMatch(html, /<script>|<b>Plain output/);
  const changed = render({ ...foreign, layer: 'accepted', review: { ...foreign.review, reason: 'changed' } });
  assert.match(changed, /文件在 Agentrix 之外被修改/);
  assert.match(changed, /当前使用：上次接受的配置/);
  assert.doesNotMatch(changed, /<pre/);
});

test('raw routing text shows control and bidi characters as visible escapes', () => {
  const raw = '{\n\t"name": "left\u202Eright\u0000\u0085\u2069"\n}';
  const html = render({ ...foreign, raw }, { rawOpen: true });
  const pre = /<pre[^>]*>(.*?)<\/pre>/s.exec(html)[1];
  assert.match(pre, /\\u000a\\u0009.*left\\u202eright\\u0000\\u0085\\u2069/);
  assert.doesNotMatch(pre, /[\p{Cc}\p{Cf}]/u);
});

test('routing review displays Ultracode turning on and off', () => {
  const withUltracode = { ...active, ultracode: true };
  const panel = (before, after) => render({ ...foreign, review: { ...foreign.review,
    roleChanges: [{ role: 'orchestrator', source: 'builtin', status: 'changed', before, after }],
  } });
  assert.match(panel(active, withUltracode), /Ultracode <span>否<\/span> → <span>是<\/span>/);
  assert.match(panel(withUltracode, active), /Ultracode <span>是<\/span> → <span>否<\/span>/);
});

test('invalid and rejected routing show only main’s allowed actions and readable raw text', () => {
  const { review, ...source } = foreign;
  const link = { ...source, raw: undefined, state: 'invalid', actions: ['keep'], error: { code: 'link', message: 'code wins' } };
  const html = render(link);
  assert.match(html, /这个文件没有被应用/);
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
