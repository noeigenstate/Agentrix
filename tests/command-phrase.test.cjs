const { test } = require('node:test');
const assert = require('node:assert/strict');
const { commandPhrase, PHRASES } = require('../electron/command-phrase.cjs');
const en = require('../electron/locales/en.json');

for (const command of [
  'mkdir -p "$TEMP/x" && cat > "$TEMP/x/brief.md"',
  'cat > brief.md', 'cat >> brief.md', 'head file > brief.md', 'tail file >> brief.md',
  'cat file 1> brief.md', 'cat file 1>> brief.md 2>&1', 'cat file &> brief.md',
  'cat <<EOF\ncontents\nEOF', "cat <<'EOF'\ncontents\nEOF", 'cat <<-EOF\ncontents\nEOF',
  'head file >out 2>/dev/null', 'tail file 2>&1 >>out', 'cat a | grep b >out',
  'head <<EOF\ncontents\nEOF', 'tail <<EOF\ncontents\nEOF',
]) test(`file output is writing: ${command.split('\n')[0]}`, () => {
  assert.deepEqual(commandPhrase(command), { phrase: '写入文件', object: '' });
});

for (const command of [
  'cat file', 'head -n 20 file', 'tail -f file', 'cat a | grep b', 'head a | grep b',
  'cat file 2>/dev/null', 'head file 2>>errors.log', 'tail file 2>&1',
  'cat file 2> /dev/null 2>&1', 'cat file 1>&2', 'cat file 2>&1 | grep b',
  'cat ">"', "head 'a>>b'", 'tail "<<EOF"', 'cat a\\>b',
]) test(`file input stays reading: ${command}`, () => {
  assert.deepEqual(commandPhrase(command), { phrase: '读取文件', object: '' });
});

test('other rule priorities and script fallback stay unchanged; the write phrase is translated', () => {
  for (const [command, phrase] of [
    ['npm test && cat >out', '运行测试'], ['git diff | cat', '查看改动'],
    ['rg needle file | head', '搜索代码'], ['grep b a | head', '搜索代码'],
    ['cat "a|b" && rg needle file', '搜索代码'],
    ['cat file && rg needle file | head', '搜索代码'],
    ['mkdir -p directory', '新建文件或目录'], ['ls > listing.txt', '查看目录'],
  ]) assert.equal(commandPhrase(command).phrase, phrase, command);
  assert.deepEqual(commandPhrase('node script.cjs'), { phrase: '运行脚本', object: 'script.cjs' });
  assert.ok(PHRASES.includes('写入文件')); assert.equal(en['写入文件'], 'Write a file');
});
