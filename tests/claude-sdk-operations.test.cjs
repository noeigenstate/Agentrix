const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { apiEnvironment } = require('../electron/features/claude-sdk/credentials.cjs');
const { routeSettings } = require('../electron/features/claude-sdk/routing.cjs');

const background = 'ANTHROPIC_DEFAULT_HAIKU_MODEL', subagent = 'CLAUDE_CODE_SUBAGENT_MODEL';

test('Claude API environment admits only the two valid operation values for owners and workers', () => {
  const inherited = { [background]: 'inherited', ANTHROPIC_BASE_URL: 'synthetic', KEEP: 'value' };
  for (const owner of ['gui', 'dispatch']) {
    const defaults = apiEnvironment(inherited, 'synthetic', owner);
    assert.equal(defaults[background], undefined);
    assert.equal(defaults[subagent], undefined);
    const set = apiEnvironment(inherited, 'synthetic', owner, {
      [background]: 'claude-sonnet-5-5', [subagent]: 'opus', ANTHROPIC_BASE_URL: 'synthetic',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: 'opus', OTHER: 'synthetic',
    });
    assert.equal(set[background], 'claude-sonnet-5-5');
    assert.equal(set[subagent], 'opus');
    for (const name of ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'OTHER']) assert.equal(set[name], undefined);
    assert.equal(set.KEEP, 'value');
    assert.equal(apiEnvironment({}, 'synthetic', owner, { [background]: '-invalid' })[background], undefined);
  }
  assert.equal(inherited[background], 'inherited');
});

test('project Claude settings pin the background variable to the operation value', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-operation-route-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const folder = path.join(cwd, '.claude'), projectName = 'Anthropic_Default_Haiku_Model';
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'settings.local.json'), JSON.stringify({ env: { [projectName]: 'project-model' } }));
  const spec = { cwd, env: { [background]: 'inherited' } };
  for (const name of [projectName, background, background.toLowerCase()]) assert.equal(routeSettings(spec).env[name], 'inherited');
  assert.equal(routeSettings({ cwd, env: {} }).env[background], '');
  const settings = routeSettings({ ...spec, operations: { env: { [background]: 'claude-sonnet-5-5' } } });
  for (const name of [projectName, background, background.toLowerCase()]) assert.equal(settings.env[name], 'claude-sonnet-5-5');
});

test('native Claude settings pin both operation variables ahead of user and project settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-operation-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'), user = path.join(root, 'profile'), folder = path.join(cwd, '.claude');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(user);
  const projectName = 'Claude_Code_Subagent_Model', userName = 'ANTHROPIC_Default_Haiku_Model';
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ env: { [userName]: 'user-background', [subagent]: 'user-subagent' } }));
  fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ env: { [background]: 'project-background', [projectName]: 'project-subagent' } }));
  const env = { CLAUDE_CONFIG_DIR: user }, operations = { env: { [background]: 'claude-sonnet-5-5', [subagent]: 'opus' } };
  assert.equal(routeSettings({ cwd, env }).env[background], 'user-background');
  for (const settings of [routeSettings({ cwd, env, operations }), routeSettings({ cwd, env: {}, operations })]) {
    for (const [key, model] of Object.entries(operations.env)) {
      assert.equal(settings.env[key], model);
      assert.equal(settings.env[key.toLowerCase()], model);
    }
    assert.equal(settings.env[projectName], 'opus');
  }
  assert.equal(routeSettings({ cwd, env, operations }).env[userName], 'claude-sonnet-5-5');
  const unopposed = routeSettings({ cwd: root, env: {}, operations });
  for (const [key, model] of Object.entries(operations.env)) assert.equal(unopposed.env[key], model);
});
