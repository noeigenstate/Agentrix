const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { isPageFile } = require('./file-kind.cjs');

const OUTSIDE = '文件在项目目录之外，无法在此预览。';
const SSH_OUTSIDE = 'SSH 项目暂不支持预览项目目录外的页面和视频';
const failure = (code, message) => Object.assign(new Error(message), { code });
const within = (root, file) => { const relative = path.relative(root, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const checked = file => { if (typeof file !== 'string' || !file || file.length > 4096 || /[\0-\x1f]/.test(file)) throw failure('INVALID_PATH', '无法预览此文件。'); return file; };
function localPath(file) {
  const normalized = checked(file).replace(/\\/g, '/');
  // Do not let realpath/stat/open initiate an SMB connection to an agent-supplied host.
  if (/^(?:\/\/|file:\/\/)/i.test(normalized) && !/^\/\/\?\/[a-z]:\//i.test(normalized)) throw failure('NETWORK_PATH', '无法预览此文件。');
  return process.platform === 'win32' ? normalized.replace(/^\/\/\?\/(?=[a-z]:\/)/i, '') : normalized;
}

async function inside(project, file, cwd = project.path) {
  const base = path.resolve(localPath(project.path)), absolute = path.resolve(localPath(cwd), localPath(file));
  if (!within(base, absolute) || absolute === base) throw failure('OUTSIDE', OUTSIDE);
  const root = await fs.realpath(base), resolved = await fs.realpath(absolute);
  localPath(resolved);
  if (!within(root, resolved)) throw failure('OUTSIDE_LINK', OUTSIDE);
  return { absolute: resolved, relative: path.relative(root, resolved).split(path.sep).join('/') };
}

async function folderGrantAllowed(root, projects = [], home = os.homedir()) {
  if (path.dirname(root) === root) return false;
  for (const value of [home, ...projects.filter(project => project?.kind !== 'ssh').map(project => project.path)]) {
    if (!value) continue;
    let real;
    try { real = await fs.realpath(localPath(value)); } catch { real = path.resolve(value); }
    if (within(root, real)) return false;
  }
  return true;
}

// Only a page or video selected for preview can grant its own folder. The real folder is carried by this
// preview alone; the project's file tree, editor and write operations keep their original root.
async function previewLocation(project, file, cwd = project.path, projects = []) {
  if (!isPageFile(checked(file))) throw failure('UNSUPPORTED', '这个文件没有预览卡片。');
  if (project.kind === 'ssh') throw failure('SSH_OUTSIDE', SSH_OUTSIDE);
  try { return { ...await inside(project, file, cwd), project, outside: false }; }
  catch (error) { if (error.code !== 'OUTSIDE') throw error; }
  const absolute = await fs.realpath(path.resolve(localPath(cwd), localPath(file))).catch(() => null);
  if (!absolute) throw failure('MISSING', '找不到这个文件。');
  localPath(absolute);
  if (!(await fs.stat(absolute)).isFile()) throw failure('MISSING', '找不到这个文件。');
  const root = path.dirname(absolute);
  const singleFile = !await folderGrantAllowed(root, [project, ...projects]);
  return { absolute, relative: path.basename(absolute), project: { ...project, path: root, previewRoot: root, previewProjectPath: project.path, previewSingleFile: singleFile }, outside: true };
}

module.exports = { inside, previewLocation, folderGrantAllowed, within, localPath, checked, failure, OUTSIDE, SSH_OUTSIDE };
