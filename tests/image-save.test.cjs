const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { saveDialogOptions, saveTarget } = require('../electron/image-save.cjs');

test('the save dialog starts in the pictures folder with the picture\'s own name and type', () => {
  const options = saveDialogOptions(path.join('C:', 'codex', 'generated_images', 't1', 'ig_1.PNG'), path.join('C:', 'Pictures'), 'Picture');
  assert.equal(options.defaultPath, path.join('C:', 'Pictures', 'ig_1.PNG'));
  assert.deepEqual(options.filters, [{ name: 'Picture', extensions: ['png'] }]);
});

test('a name picked without an extension keeps the type the picture came with', () => {
  const file = path.join('generated_images', 't', 'one.webp');
  assert.equal(saveTarget(path.join('out', 'poster'), file), path.join('out', 'poster.webp'));
  assert.equal(saveTarget(path.join('out', 'poster.jpg'), file), path.join('out', 'poster.jpg'));
});
