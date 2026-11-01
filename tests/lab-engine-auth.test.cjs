const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  cliHomes, credentialAccess, gitCredentialPaths, gitCredentialHelpers, sandboxProfile, cleanEnvironment,
} = require('../electron/features/lab/sandbox.cjs');
const { command, git, gitEnvironment } = require('../electron/features/lab/process.cjs');
const { dispatch, claudeLoginFailed, CLAUDE_LOGIN_ERROR } = require('../electron/features/lab/dispatch.cjs');

async function temporary(t) {
  const base = process.platform === 'darwin' ? path.join(os.homedir(), '.ctmp') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'lab-auth-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('every run process ignores global Git config, disables prompts and optional locks, and drops the SSH agent', async t => {
  const root = await temporary(t), global = path.join(root, 'gitconfig');
  await fs.writeFile(global, '[credential]\n\thelper = forbidden-owner-helper\n');
  const dirty = {
    ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '0',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'another-owner-helper',
    GIT_OPTIONAL_LOCKS: '1', GIT_TERMINAL_PROMPT: '1', SSH_AUTH_SOCK: path.join(root, 'agent.sock'),
  };
  const safe = gitEnvironment(dirty);
  assert.equal(safe.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(safe.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(safe.GIT_TERMINAL_PROMPT, '0');
  assert.equal(safe.GIT_OPTIONAL_LOCKS, '0'); assert.equal(safe.SSH_AUTH_SOCK, undefined);
  assert.equal(safe.GIT_CONFIG_COUNT, undefined);
  const code = "const c=require('node:child_process').spawnSync('git',['config','--global','--get','credential.helper']);" +
    "console.log(JSON.stringify({env:process.env.GIT_OPTIONAL_LOCKS,code:c.status,out:String(c.stdout)}));";
  const result = await command(process.execPath, ['-e', code], { cwd: root, env: dirty });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { env: '0', code: 1, out: '' });
});

test('owner Git reads leave an existing index.lock untouched and use optional-locks zero', async t => {
  const root = await temporary(t), repository = path.join(root, 'project');
  await fs.mkdir(repository);
  await git(repository, ['init']);
  await fs.writeFile(path.join(repository, 'file.txt'), 'working change\n');
  const lock = path.join(repository, '.git/index.lock');
  await fs.writeFile(lock, 'owned by another agent\n');
  const status = await git(repository, ['status', '--porcelain=v1'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' } });
  assert.match(status, /file\.txt/);
  assert.equal(await fs.readFile(lock, 'utf8'), 'owned by another agent\n');
});

test('Codex auth is a shared file link, refresh writes reach the owner file and no credential copy is created', async t => {
  const root = await temporary(t), source = path.join(root, 'owner-codex'), run = path.join(root, 'run');
  await fs.mkdir(source);
  const auth = path.join(source, 'auth.json');
  await fs.writeFile(auth, '{"fakeAccess":"old","fakeRefresh":"one"}\n');
  await fs.writeFile(path.join(source, 'config.toml'), 'model = "fixture"\n');
  const env = await cliHomes({ CODEX_HOME: source, CLAUDE_CONFIG_DIR: path.join(root, 'owner-claude') }, run);
  const local = path.join(env.CODEX_HOME, 'auth.json');
  assert.equal((await fs.lstat(local)).isSymbolicLink(), true);
  assert.equal(await fs.realpath(local), auth);
  await fs.writeFile(local, '{"fakeAccess":"new","fakeRefresh":"two"}\n');
  assert.equal(await fs.readFile(auth, 'utf8'), '{"fakeAccess":"new","fakeRefresh":"two"}\n');
  assert.equal((await fs.lstat(local)).isSymbolicLink(), true);
  assert.equal(await fs.stat(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')).catch(() => null), null);
  const grading = await cliHomes({ CODEX_HOME: source }, path.join(root, 'grading'), false);
  assert.equal(await fs.lstat(path.join(grading.CODEX_HOME, 'auth.json')).catch(() => null), null);
});

test('Claude keeps the owner Keychain service identity while its run directory stays separate', async t => {
  const root = await temporary(t), custom = path.join(root, 'custom-claude'), secure = path.join(root, 'secure');
  for (const [original, expected] of [
    [{}, ''],
    [{ CLAUDE_CONFIG_DIR: custom }, custom],
    [{ CLAUDE_CONFIG_DIR: custom, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure }, secure],
    [{ CLAUDE_CONFIG_DIR: custom, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }, ''],
  ]) {
    const dir = path.join(root, 'run-' + Math.random().toString(16).slice(2));
    const env = await cliHomes({ CODEX_HOME: path.join(root, 'unused'), ...original }, dir);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, expected);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(dir, 'claude'));
    assert.notEqual(env.CLAUDE_CONFIG_DIR, custom);
    assert.equal(await fs.stat(path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json')).catch(() => null), null);
  }
});

test('sandbox blocks Git credential paths and helper execution but permits only shared Codex auth content', {
  skip: process.platform !== 'darwin' ? 'macOS filesystem isolation is required' : false,
}, async t => {
  const root = await temporary(t), owner = path.join(root, 'owner'), lab = path.join(root, 'lab');
  const workspace = path.join(lab, 'workspace'), source = path.join(owner, '.codex');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(source, { recursive: true });
  const auth = path.join(source, 'auth.json');
  await fs.writeFile(auth, '{"fakeRefresh":"old"}\n');
  await fs.writeFile(path.join(source, 'other.json'), 'private history\n');
  const secrets = [
    '.ssh/id_test', '.config/gh/hosts.yml', '.git-credentials', '.gitconfig', '.config/git/credentials',
  ];
  for (const name of secrets) {
    const file = path.join(owner, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fake Git credential\n');
  }
  const helper = path.join(owner, 'bin/git-credential-osxkeychain');
  await fs.mkdir(path.dirname(helper));
  await fs.writeFile(helper, '#!/bin/sh\necho should-not-run\n', { mode: 0o700 });
  await git(workspace, ['init']);
  const access = await credentialAccess({ CODEX_HOME: source });
  const env = await cliHomes({ ...cleanEnvironment(process.env), CODEX_HOME: source,
    CLAUDE_CONFIG_DIR: path.join(root, 'unused-claude') }, path.join(workspace, 'home'), true, access);
  const profile = sandboxProfile({
    labRoot: lab, readRoots: [workspace], writeRoots: [workspace], protectedPaths: [],
    credentialPaths: gitCredentialPaths(owner), deniedExecutables: [helper], ...access,
  });
  const script = "const fs=require('node:fs'),p=require('node:path'),c=require('node:child_process');" +
    "const input=JSON.parse(process.argv[1]);" +
    "const denied=f=>{try{fs.readFileSync(f);return false}catch{return true}};" +
    "const paths=input.secrets.map(f=>denied(p.join(input.owner,f)));" +
    "const helper=c.spawnSync(input.helper,[],{encoding:'utf8'});" +
    "const remotes=c.spawnSync('git',['remote'],{encoding:'utf8'}).stdout.trim();" +
    "fs.writeFileSync(p.join(process.env.CODEX_HOME,'auth.json'),'{\"fakeRefresh\":\"new\"}\\n');" +
    "let writeDenied=false;try{fs.writeFileSync(p.join(input.source,'other.json'),'changed')}catch{writeDenied=true}" +
    "console.log(JSON.stringify({paths,execDenied:helper.status!==0,remotes,writeDenied," +
    "otherDenied:denied(p.join(input.source,'other.json'))}));";
  const result = await command('/usr/bin/sandbox-exec', [
    '-p', profile, process.execPath, '-e', script, JSON.stringify({ owner, source, helper, secrets }),
  ], { cwd: workspace, env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    paths: secrets.map(() => true), execDenied: true, remotes: '', writeDenied: true, otherDenied: true,
  });
  assert.equal(await fs.readFile(auth, 'utf8'), '{"fakeRefresh":"new"}\n');
  assert.equal(await fs.readFile(path.join(source, 'other.json'), 'utf8'), 'private history\n');
  assert.ok((await gitCredentialHelpers()).every(file => path.basename(file) === 'git-credential-osxkeychain'));
});

test('Claude login failures become a clear run error including when only the native log explains the failure', async t => {
  const root = await temporary(t), control = path.join(root, 'control');
  await fs.mkdir(control);
  const controller = new AbortController();
  const session = {
    control, workspaceRoot: root, publicHelper: '/fake-dispatch',
    async root(args) {
      const out = args[args.indexOf('--out') + 1];
      await fs.writeFile(out + '.log', '{"type":"error","error":{"type":"authentication_error","message":"Not logged in"}}\n');
      return { code: 1, stdout: '[dispatch] failed to start fixture: worker exited', stderr: '' };
    },
  };
  await assert.rejects(dispatch({
    arm: 'opus', cwd: root, directory: root, session, usage: { calls: new Map() },
    signal: controller.signal, task: { text: 'fixture' },
  }), { message: CLAUDE_LOGIN_ERROR });
  assert.equal(CLAUDE_LOGIN_ERROR, '无法登录 Claude');
  assert.equal(await claudeLoginFailed({ stdout: 'rate_limit_error 429', stderr: '' }, path.join(root, 'missing')), false);
});
