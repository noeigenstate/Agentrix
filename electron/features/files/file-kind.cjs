const path = require('node:path');
const { VIDEO_TYPES } = require('../../project-files.cjs');
const kinds = new Map([
  ...['.md', '.markdown', '.mdx'].map(ext => [ext, 'markdown']),
  ...['.html', '.htm'].map(ext => [ext, 'html']),
  ...Object.keys(VIDEO_TYPES).map(ext => [ext, 'video']),
  ...['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].map(ext => [ext, 'image']),
]);
const cardKind = file => typeof file === 'string' ? kinds.get(path.extname(file).toLowerCase()) || null : null;
const isImageFile = file => cardKind(file) === 'image' && !/^[\\/]{2}/.test(file);
const isPageFile = file => ['html', 'video'].includes(cardKind(file));
module.exports = { cardKind, isImageFile, isPageFile };
