const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDelivery } = require('../src/features/home/delivery.ts');

test('a fix summary gives the problem, its cause and the result, in that order', () => {
  const reply = '改好了，细节如下。\n\n- 改了 pipeline.py\n\n【交付】\n问题：预处理太慢，把后面的节点卡住了\n原因：每张图都单独开线程，线程池被预处理占满\n结果：100 张图从 41 秒降到 12 秒，pytest 全部通过';
  assert.deepEqual(parseDelivery(reply), { kind: 'fix', parts: [
    { label: '要解决的问题', text: '预处理太慢，把后面的节点卡住了' },
    { label: '具体原因', text: '每张图都单独开线程，线程池被预处理占满' },
    { label: '结果', text: '100 张图从 41 秒降到 12 秒，pytest 全部通过' },
  ] });
});

test('an optimization summary gives what was done, what it solves and before and after', () => {
  const reply = '## 交付\n- **优化**：图片批量解码\n- **解决**: 预处理阻塞分析\n- **对比**：之前 0.51 秒/张\n  之后 0.12 秒/张';
  const delivery = parseDelivery(reply);
  assert.equal(delivery.kind, 'optimize');
  assert.deepEqual(delivery.parts.map(part => part.label), ['做了什么优化', '解决了什么问题', '前后对比']);
  assert.equal(delivery.parts[2].text, '之前 0.51 秒/张\n之后 0.12 秒/张');
});

test('English labels, the last summary when there are several, and nothing for a partial or missing one', () => {
  const english = parseDelivery('Delivery:\nProblem: login fails\nCause: token expired early\nResult: fixed, tests pass');
  assert.deepEqual(english.parts.map(part => part.text), ['login fails', 'token expired early', 'fixed, tests pass']);
  const twice = parseDelivery('【交付】\n问题：旧的\n原因：旧\n结果：旧\n\n又改了一次。\n\n【交付】\n问题：新的\n原因：新\n结果：新');
  assert.equal(twice.parts[0].text, '新的');
  assert.equal(parseDelivery('【交付】\n问题：只写了问题\n结果：没有原因'), null);
  assert.equal(parseDelivery('回滚步骤已补上，测试全部通过。'), null);
  assert.equal(parseDelivery(''), null);
});

test('a reply that is nothing but its 交付 block keeps it, so the reading card is never empty', () => {
  const { withoutDelivery } = require('../src/features/home/delivery.ts');
  const only = '【交付】\n问题：A\n原因：B\n结果：C';
  assert.equal(withoutDelivery(only), only);
  assert.equal(withoutDelivery(`Done.\n\n${only}`), 'Done.');
});
