const fs = require('node:fs/promises');
const path = require('node:path');
const { resolveProjectPath, VIDEO_TYPES } = require('../../project-files.cjs');

const OUTSIDE = '文件在项目目录之外，无法在此预览。';
const SSH_OUTSIDE = 'SSH 项目暂不支持预览项目目录外的页面和视频';
const localPath = value => {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\/(?=[a-z]:\/)/i, '') : normalized;
};
const checked = file => { if (typeof file !== 'string' || !file || file.length > 4096 || /[\0-\x1f]/.test(file)) throw new Error('无法预览此文件。'); return file; };
const pageKind = file => /\.html?$/i.test(file) ? 'html' : VIDEO_TYPES[path.extname(file).toLowerCase()] ? 'video' : null;

async function inside(project, file, cwd = project.path) {
  const absolute = path.resolve(localPath(cwd), localPath(checked(file)));
  const relative = path.relative(localPath(project.path), absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || relative.includes(':')) throw new Error(OUTSIDE);
  try { return { absolute: await resolveProjectPath(project, relative), relative }; }
  catch (error) { if (error.message === '该链接指向项目目录之外，无法在此打开。') throw new Error(OUTSIDE); throw error; }
}

// Only a page or video selected for preview can grant its own folder. The real folder is carried by this
// preview alone; the project's file tree, editor and write operations keep their original root.
async function previewLocation(project, file, cwd = project.path) {
  if (!pageKind(checked(file))) throw new Error('这个文件没有预览卡片。');
  if (project.kind === 'ssh') throw new Error(SSH_OUTSIDE);
  try { return { ...await inside(project, file, cwd), project, outside: false }; }
  catch (error) { if (error.message !== OUTSIDE) throw error; }
  const absolute = await fs.realpath(path.resolve(localPath(cwd), localPath(file))).catch(() => null);
  if (!absolute || !(await fs.stat(absolute)).isFile()) throw new Error('找不到这个文件。');
  const root = path.dirname(absolute);
  return { absolute, relative: path.basename(absolute), project: { ...project, path: root, previewRoot: root }, outside: true };
}

module.exports = { inside, previewLocation, pageKind, localPath, checked, OUTSIDE, SSH_OUTSIDE };
