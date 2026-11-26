const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scrubText, scrubSkills } = require('../electron/features/agents/skill-privacy.cjs');

function check(input, expected, findings, context) {
  const first = scrubText(input, context);
  assert.deepEqual(first, { text: expected, findings });
  assert.deepEqual(scrubText(first.text, context), { text: expected, findings: {} }, 'second scrub must be a no-op');
}

test('private key blocks are removed whole, including multiline bodies', () => {
  check('不要保存私钥：\r\n-----BEGIN RSA PRIVATE KEY-----\r\nYWJj\r\n-----END RSA PRIVATE KEY-----\r\n'
    + '-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----\n'
    + '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJj\n-----END OPENSSH PRIVATE KEY-----',
  '不要保存私钥：\r\n<private-key>\r\n<private-key>\n<private-key>', { 'private-key': 3 });
});

test('all API key and token prefixes are hidden', () => {
  const tokens = [
    'sk-Abc123def456Ghi789', 'sk-ant-api03-Abc123_def456-Ghi789', 'sk-proj-Abc123_def456-Ghi789',
    'ghp_Abc123def456Ghi789', 'gho_Abc123def456Ghi789', 'ghs_Abc123def456Ghi789',
    'github_pat_11Abc123_def456Ghi789',
    ...'abprs'.split('').map(letter => `xox${letter}-1234567890-0987654321-Abc123def456`),
    'AKIAIOSFODNN7EXAMPLE',
  ];
  check('Observed credentials: ' + tokens.join(', '), 'Observed credentials: ' + tokens.map(() => '<secret>').join(', '), { secret: tokens.length });
});

test('Bearer values and JWTs are hidden, with authorization labels kept', () => {
  check('Authorization: Bearer abcDEF123+/==\nbearer opaque-token_456\nJWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_123',
    'Authorization: Bearer <secret>\nbearer <secret>\nJWT <secret>', { secret: 3 });
});

const assignments = [
  ['PASSWORD=hunter2', 'PASSWORD=<secret>'],
  ['passwd: p@ss-word!', 'passwd: <secret>'],
  ['pwd = "two words"', 'pwd = "<secret>"'],
  ["secret='two words'", "secret='<secret>'"],
  ['token: abc123', 'token: <secret>'],
  ['api_key=abc123', 'api_key=<secret>'],
  ['apikey = abc123', 'apikey = <secret>'],
  ['access_key: abc123', 'access_key: <secret>'],
  ['client_secret: abc123', 'client_secret: <secret>'],
  ['"password": "space and \\"quote\\""', '"password": "<secret>"'],
  ['{"token":"ghp_Abc123def456", "retries": 3}', '{"token":"<secret>", "retries": 3}'],
  ['export MY_API_KEY=abc123 # local only', 'export MY_API_KEY=<secret> # local only'],
  ['curl --password "secret phrase" --retry 3', 'curl --password "<secret>" --retry 3'],
  ['mysql --password fg@xxxx', 'mysql --password <secret>'],
  ['密码是xxx', '密码是<secret>'],
  ['密码是 fg@xxxx', '密码是 <secret>'],
  ['密码：xxx', '密码：<secret>'],
  ['口令: local-pass; 密钥=private-value', '口令: <secret>; 密钥=<secret>'],
];
for (const [input, expected] of assignments) {
  test(`secret assignment: ${input}`, () => check(input, expected, { secret: input.startsWith('口令') ? 2 : 1 }));
}

test('URL credentials keep the scheme and host', () => {
  check('Connect https://lisa:p%40ss@build.example.org:8443/api and ssh://root:abc@192.168.122.2/repo',
    'Connect https://<user>:<secret>@build.example.org:8443/api and ssh://<user>:<secret>@<ip>/repo',
    { 'url-credentials': 2, ip: 1 });
});

test('email addresses in English and Chinese skill text are hidden', () => {
  check('Contact lisa.dev+ci@example.com，备用邮箱：OPS@Example.ORG。', 'Contact <email>，备用邮箱：<email>。', { email: 2 });
});

test('Chinese and international phone numbers accept spaced and dashed formats', () => {
  const numbers = ['13800138000', '+86 138 0013 8000', '86-139-0013-8000', '1 5 6 0 0 1 3 8 0 0 0', '+1-415-555-2671', '+442079460958', '+12345678', '+123456789012345'];
  check('电话：' + numbers.join('；'), '电话：' + numbers.map(() => '<phone>').join('；'), { phone: numbers.length });
});

test('ID numbers require a real calendar date and are counted before phones', () => {
  check('证件 11010519491231002X / 110105200002290021 / 110105199002300021 / 110105200113010021',
    '证件 <id-number> / <id-number> / 110105199002300021 / 110105200113010021', { 'id-number': 2 });
});

test('IPv4 addresses validate octets and preserve punctuation and ports', () => {
  check('Host 192.168.122.2:22; peer 10.0.0.8. DNS 8.8.8.8; invalid 256.12.3.4, 10.400.0.1',
    'Host <ip>:22; peer <ip>. DNS <ip>; invalid 256.12.3.4, 10.400.0.1', { ip: 3 });
});

test('automatic home paths keep the suffix and slash style', () => {
  check(String.raw`Use C:\Users\fixture\Desktop\projectgrid and D:/Users/Lisa/code, /home/lisa/piv_lab and /Users/alex/src.`,
    String.raw`Use <home>\Desktop\projectgrid and <home>/code, <home>/piv_lab and <home>/src.`, { home: 4 });
});

test('home paths in JSON strings and Windows names with spaces are hidden', () => {
  check(String.raw`{"cwd":"C:\\Users\\fixture\\Desktop\\projectgrid"}; C:\Users\Jane Doe\code`,
    String.raw`{"cwd":"<home>\\Desktop\\projectgrid"}; <home>\code`, { home: 2 });
});

test('GitHub runner home paths stay visible and similarly named private paths are hidden', () => {
  check(String.raw`C:\Users\RUNNER~1\AppData; C:/users/RunnerAdmin/work; {"cwd":"C:\\Users\\runner~1\\work"}; C:\Users\runneradmin-local\work`,
    String.raw`C:\Users\RUNNER~1\AppData; C:/users/RunnerAdmin/work; {"cwd":"C:\\Users\\runner~1\\work"}; <home>\work`, { home: 1 });
});

test('ordinary technical content is unchanged', () => {
  const text = [
    '# Build / 构建',
    'git version 1.8.3.1; Version: 4.3.2.1; ver 10.20.30.40; v 3.4.5.6; v1.2.3.4; pkg@1.2.3.4',
    'Dotted runs: 1.2.3.4.5 and 12.34.56.78.90',
    'git show 47e638726b550883a2473b95d884327364e976a9',
    'UUID 550e8400-e29b-41d4-a716-446655440000; numbers 12345678901234567 and +1234567890123456',
    '2026-10-12 13:45:09; 1990/01/01; port 8443',
    'http://localhost:3000/api and https://docs.example.org/setup',
    '127.0.0.1 0.0.0.0 255.255.255.255 192.0.2.7 198.51.100.18 203.0.113.255',
    String.raw`C:\Users\Public\Documents; C:/Users/Public; /home; /root/work`,
    './skills/build/SKILL.md ../helpers/check.ps1 src/user.ts',
    '```js\nconst revision = "abcd1234";\nconsole.log("localhost");\n```',
    'password=""; token=\'\'; mypasswordish=value; tokenizer: value',
  ].join('\n');
  check(text, text, {});
});

test('context literals ignore case, regex syntax, duplicates, and short entries', () => {
  const context = {
    homes: ['E:\\Work\\Lisa', '/srv/staff/Lisa/', '/root', 'ab', ''],
    users: ['Lisa', 'LISA', 'xy', ''],
    hosts: ['BUILD[01]', '192.168.122.2', 'ab', ''],
    words: ['Internal (Alpha)', 'SECRET', 'xy', ''],
  };
  check(String.raw`e:\work\LISA\src /SRV/staff/lisa/tools /root/data Lisa lisa LISA Lisa2 alisa BUILD[01] 192.168.122.2 INTERNAL (alpha) ab xy <secret>`,
    String.raw`<home>\src <home>/tools <home>/data <user> <user> <user> Lisa2 alisa <host> <host> <redacted> ab xy <secret>`,
    { home: 3, user: 3, host: 2, word: 1 }, context);
});

test('context users have Unicode word boundaries and homes match complete path components', () => {
  check('alex alexander dev_alex 中文小王同 小王同 /srv/team/app /srv/teammate/app',
    '<user> alexander dev_alex 中文小王同 <user> <home>/app /srv/teammate/app',
    { user: 2, home: 1 }, { users: ['alex', '小王同', '中文'], homes: ['/srv/team'] });
});

test('all placeholders, including assignment values, remain protected from context', () => {
  const text = '<private-key> <secret> <user> <email> <phone> <id-number> <ip> <home> <host> <redacted>\n'
    + 'password="<secret>" token=<secret> --password <secret> Bearer <secret> https://<user>:<secret>@server.example.org';
  check(text, text, {}, { users: ['user'], hosts: ['host'], words: ['secret', 'home', 'email', 'redacted', '<phone>'] });
});

test('a combined skill counts each sensitive piece once', () => {
  const input = '密码是 fg@xxxx\nEmail lisa@example.org\n电话 13800138000\n证件 11010519491231002X\n'
    + 'ssh://admin:password@10.0.0.8\n/home/lisa/code\nLisa BUILD01 private team';
  check(input, '密码是 <secret>\nEmail <email>\n电话 <phone>\n证件 <id-number>\n'
    + 'ssh://<user>:<secret>@<ip>\n<home>/code\n<user> <host> <redacted>',
  { secret: 1, email: 1, phone: 1, 'id-number': 1, 'url-credentials': 1, ip: 1, home: 1, user: 1, host: 1, word: 1 },
  { users: ['lisa'], hosts: ['build01'], words: ['private team'] });
});

test('context replacements that expose new token boundaries are scrubbed in the same call', () => {
  check('prefixsk-Abc123def456 prefixLisa', '<redacted><secret> <redacted><user>',
    { word: 2, secret: 1, user: 1 }, { words: ['prefix'], users: ['lisa'] });
});

test('SSH user@IP addresses are scrubbed while scoped npm package versions are kept', () => {
  check('ssh deploy@192.168.122.2\nscp lisa@10.0.0.8:/repo ./repo\n@scope/pkg@1.2.3.4',
    'ssh deploy@<ip>\nscp lisa@<ip>:/repo ./repo\n@scope/pkg@1.2.3.4', { ip: 2 });
});

async function temporaryFolder(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'agentrix-skill-privacy-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}

test('scrubSkills rewrites only changed text files and preserves BOM, CRLF, and clean mtime', async t => {
  const folder = await temporaryFolder(t);
  await fs.mkdir(path.join(folder, 'helpers'));
  const dirty = path.join(folder, 'SKILL.md'), helper = path.join(folder, 'helpers', 'check.PS1'), clean = path.join(folder, 'clean.md');
  await fs.writeFile(dirty, '\uFEFF# 本地调试\r\n密码是 fg@xxxx\r\n路径 C:\\Users\\fixture\\Desktop\\projectgrid\r\n');
  await fs.writeFile(helper, '$env:API_KEY="sk-proj-Abc123def456Ghi789"\n');
  const cleanBytes = Buffer.from('# Build\r\nRun `npm test` at localhost:3000.\r\n');
  await fs.writeFile(clean, cleanBytes);
  await fs.utimes(clean, new Date('2020-01-01'), new Date('2020-01-01'));
  const before = await fs.stat(clean);
  const changes = await scrubSkills(folder);
  assert.deepEqual(changes.sort((a, b) => a.file.localeCompare(b.file)), [
    { file: 'helpers/check.PS1', findings: { secret: 1 } },
    { file: 'SKILL.md', findings: { secret: 1, home: 1 } },
  ]);
  const result = await fs.readFile(dirty);
  assert.deepEqual([...result.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(result.toString('utf8'), '\uFEFF# 本地调试\r\n密码是 <secret>\r\n路径 <home>\\Desktop\\projectgrid\r\n');
  assert.equal(await fs.readFile(helper, 'utf8'), '$env:API_KEY="<secret>"\n');
  assert.deepEqual(await fs.readFile(clean), cleanBytes);
  assert.equal((await fs.stat(clean)).mtimeMs, before.mtimeMs);
  const dirtyMtime = (await fs.stat(dirty)).mtimeMs;
  assert.deepEqual(await scrubSkills(folder), []);
  assert.equal((await fs.stat(dirty)).mtimeMs, dirtyMtime);
});

test('scrubSkills handles every supported extension and no extension, passing context through', async t => {
  const folder = await temporaryFolder(t);
  const names = ['README', ...['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'sh', 'ps1', 'py', 'js', 'cjs', 'mjs', 'ts'].map(ext => `helper.${ext.toUpperCase()}`)];
  for (const name of names) await fs.writeFile(path.join(folder, name), 'Build host BUILDNODE');
  const changes = await scrubSkills(folder, { hosts: ['buildnode'] });
  assert.equal(changes.length, names.length);
  for (const item of changes) {
    assert.ok(names.includes(item.file));
    assert.deepEqual(item.findings, { host: 1 });
    assert.equal(await fs.readFile(path.join(folder, item.file), 'utf8'), 'Build host <host>');
  }
});

test('scrubSkills skips binaries, invalid UTF-8, oversized and unsupported files and excluded directories', async t => {
  const folder = await temporaryFolder(t);
  const fixtures = new Map([
    ['binary.md', Buffer.from('password=local-secret\0binary')],
    ['invalid.txt', Buffer.concat([Buffer.from('password=local-secret'), Buffer.from([0xff, 0xfe])])],
    ['controls.md', Buffer.from('password=local-secret\x01\x02')],
    ['large.txt', Buffer.from('password=local-secret\n' + 'x'.repeat(1024 * 1024))],
    ['image.png', Buffer.from('password=local-secret')],
    ['notes.html', Buffer.from('password=local-secret')],
    ['node_modules/tool/SKILL.md', Buffer.from('password=local-secret')],
    ['.git/SKILL.md', Buffer.from('password=local-secret')],
  ]);
  for (const [name, bytes] of fixtures) {
    const file = path.join(folder, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  assert.deepEqual(await scrubSkills(folder), []);
  for (const [name, bytes] of fixtures) assert.deepEqual(await fs.readFile(path.join(folder, name)), bytes, name);
});

test('scrubSkills includes files exactly at the size limit', async t => {
  const folder = await temporaryFolder(t);
  const file = path.join(folder, 'limit.txt');
  const prefix = 'password=local-secret\n';
  await fs.writeFile(file, prefix + 'x'.repeat(1024 * 1024 - Buffer.byteLength(prefix)));
  assert.deepEqual(await scrubSkills(folder), [{ file: 'limit.txt', findings: { secret: 1 } }]);
  assert.ok((await fs.readFile(file, 'utf8')).startsWith('password=<secret>\n'));
});

test('scrubSkills does not follow directory symlinks, including a symlink at the root', async t => {
  const folder = await temporaryFolder(t), outside = await temporaryFolder(t);
  const external = path.join(outside, 'SKILL.md');
  await fs.writeFile(external, 'password=external-secret');
  // Junctions are directory symlinks that do not need Windows developer mode.
  const link = path.join(folder, 'linked');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await scrubSkills(folder), []);
  assert.deepEqual(await scrubSkills(link), []);
  assert.equal(await fs.readFile(external, 'utf8'), 'password=external-secret');
});

test('scrubSkills does not follow file symlinks', async t => {
  const folder = await temporaryFolder(t), outside = await temporaryFolder(t);
  const external = path.join(outside, 'SKILL.md');
  await fs.writeFile(external, 'password=external-secret');
  try { await fs.symlink(external, path.join(folder, 'linked.md'), 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('Windows file symlinks require developer mode or symlink privileges');
    return;
  }
  assert.deepEqual(await scrubSkills(folder), []);
  assert.equal(await fs.readFile(external, 'utf8'), 'password=external-secret');
});

test('a missing skills folder returns an empty list', async t => {
  const folder = await temporaryFolder(t);
  assert.deepEqual(await scrubSkills(path.join(folder, 'missing')), []);
});

test('an agent-written projectgrid SKILL.md leaves none of the original private values', async t => {
  const folder = await temporaryFolder(t);
  const sensitive = ['C:\\Users\\fixture\\Desktop\\projectgrid', 'root@192.168.122.2', 'fg@xxxx', 'fixture.personal@example.com', '13800138000'];
  const skill = '# Project Grid 调试步骤\n\n'
    + `在 ${sensitive[0]} 运行 npm test。\n远程排查：ssh ${sensitive[1]}\n密码是 ${sensitive[2]}\n`
    + `如需联系作者：${sensitive[3]}，电话 ${sensitive[4]}。\n记录 git version 1.8.3.1，保持 CRLF。\n`;
  await fs.writeFile(path.join(folder, 'SKILL.md'), skill);
  const expected = '# Project Grid 调试步骤\n\n在 <home>\\Desktop\\projectgrid 运行 npm test。\n'
    + '远程排查：ssh root@<ip>\n密码是 <secret>\n如需联系作者：<email>，电话 <phone>。\n记录 git version 1.8.3.1，保持 CRLF。\n';
  check(skill, expected, { home: 1, ip: 1, secret: 1, email: 1, phone: 1 });
  assert.deepEqual(await scrubSkills(folder), [{ file: 'SKILL.md', findings: { home: 1, ip: 1, secret: 1, email: 1, phone: 1 } }]);
  const output = await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8');
  assert.equal(output, expected);
  for (const value of sensitive) assert.ok(!output.includes(value), `private value survived: ${value}`);
});
