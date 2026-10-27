const path = require('node:path');
const fs = require('node:fs');
const { findFiles, listDirectory, readProjectFile, saveProjectFile, resolveProjectPath, VIDEO_TYPES } = require('../../project-files.cjs');
const { projectPaths } = require('../../project-paths.cjs');
const { resolveTerminalLink } = require('../../terminal-links.cjs');

function registerFilesIpc({ handle, listen, findProject, remoteFor, fileOperations, clipboardWrites, clipboard, previewResources, affectsEditor, allowEditorClose, shell, getActiveFileTree, setActiveFileTree, setActiveTerminal, send }) {
  const fileSaves = new Set();
  let fileProgress = null;
  handle('project:directory', (id, relativePath = '', offset = 0) => {
    const project = findProject(id);
    return project.kind === 'ssh' ? remoteFor(id).request('directory', { path: relativePath, offset }) : listDirectory(project, relativePath, offset);
  });
  handle('project:findFiles', (projectId, query) => findFiles(findProject(projectId), query));
  handle('project:create-entry', (id, directory, name, kind) => fileOperations.create(findProject(id), directory, name, kind));
  handle('project:rename-entry', async (id, relative, name) => {
    if (affectsEditor(id, [relative]) && !await allowEditorClose()) throw new Error('已取消重命名。');
    return fileOperations.rename(findProject(id), relative, name);
  });
  handle('project:delete-entries', async (id, paths) => {
    if (Array.isArray(paths) && affectsEditor(id, paths) && !await allowEditorClose()) return { deleted: [] };
    return fileOperations.remove(findProject(id), paths);
  });
  handle('project:copy-entries', (id, paths) => fileOperations.copy(findProject(id), paths));
  handle('project:copy-paths', async (id, paths, format) => {
    const project = findProject(id);
    const revision = clipboardWrites.reserve();
    const remote = project.kind === 'ssh' && format === 'absolute' ? remoteFor(id) : null;
    if (remote) await remote.ready;
    const value = projectPaths(project, paths, format, remote?.info.root);
    if (!await clipboardWrites.commit(revision, () => clipboard.writeText(value))) return { count: 0, superseded: true };
    return { count: paths.length };
  });
  handle('project:paste-entries', (id, directory) => fileOperations.paste(findProject(id), directory));
  handle('files:progress', () => fileProgress);
  handle('files:cancel', () => fileOperations.cancel());
  listen('files:focus', (id, focused) => { if (focused) { findProject(id); setActiveFileTree(id); setActiveTerminal(null); } else if (getActiveFileTree() === id) setActiveFileTree(null); });
  async function readFile(id, relativePath, pageIndex) {
    const project = findProject(id);
    const preview = project.kind === 'ssh' ? await remoteFor(id).request('preview', { path: relativePath, page: pageIndex || 0 }) : await readProjectFile(project, relativePath, pageIndex);
    if (['image', 'html', 'markdown', 'video'].includes(preview.kind)) return { ...preview, ...previewResources.open(project, relativePath, preview.kind, preview.mimeType) };
    return preview;
  }
  handle('project:file', readFile);
  handle('project:preview-close', id => previewResources.close(id));
  async function saveFile(id, relativePath, pageIndex, revision, content) {
    const project = findProject(id), key = `${project.id}:${relativePath}`;
    if (fileSaves.has(key)) throw new Error('此文件正在保存，请稍候。');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('本次编辑内容超过 1 MB，请分段保存。');
    fileSaves.add(key);
    try {
      const preview = project.kind === 'ssh'
        ? await remoteFor(id).request('save-file', { path: relativePath, page: pageIndex, revision, data: Buffer.from(content, 'utf8').toString('base64') })
        : await saveProjectFile(project, relativePath, pageIndex, revision, content);
      if (['html', 'markdown'].includes(preview.kind)) return { ...preview, ...previewResources.open(project, relativePath, preview.kind) };
      return preview;
    } finally { fileSaves.delete(key); }
  }
  handle('project:save-file', saveFile);
  async function openPath(filename) {
    const error = await shell.openPath(filename);
    if (error) throw new Error(error);
  }
  async function openProjectLink(id, target) {
    const project = findProject(id);
    if (project.kind === 'ssh' && !/^(https?:\/\/|www\.)/i.test(target)) {
      const remote = remoteFor(id); await remote.ready;
      let value = String(target);
      if (/^file:\/\//i.test(value)) value = decodeURIComponent(new URL(value).pathname);
      else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/:[0-9]+(?::[0-9]+)?$/.test(value)) throw new Error('只支持网页链接和远程项目内文件。');
      const withoutPosition = value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '');
      for (const candidate of new Set([value, withoutPosition])) {
        const relative = path.posix.relative(remote.info.root, path.posix.resolve(remote.info.root, candidate));
        if (relative === '..' || relative.startsWith('../')) throw new Error('该链接指向远程项目目录之外。');
        try {
          const stat = await remote.request('stat', { path: relative });
          if (stat.directory) return { kind: 'directory', path: stat.realPath === '.' ? '' : stat.realPath };
          return { kind: 'file', path: relative };
        } catch (error) { if (candidate === withoutPosition) throw error; }
      }
    }
    const link = await resolveTerminalLink(project, target);
    if (link.kind === 'external') { await shell.openExternal(link.url); return { kind: 'external' }; }
    if (link.kind === 'directory') { await openPath(link.path); return { kind: 'external' }; }
    return link;
  }
  handle('project:open-link', openProjectLink);
  async function openVideo(id, relativePath) {
    const project = findProject(id);
    if (project.kind === 'ssh') throw new Error('远程视频请使用内置播放器，或先下载到本机再用系统播放器打开。');
    const resolved = await resolveProjectPath(project, relativePath);
    if (!VIDEO_TYPES[path.extname(resolved).toLowerCase()] || !(await fs.promises.stat(resolved)).isFile()) throw new Error('请选择一个视频文件。');
    await openPath(resolved);
  }
  handle('project:open-video', openVideo);
  async function revealProject(id) {
    const project = findProject(id);
    if (project.kind === 'ssh') return { kind: 'directory', path: '' };
    await openPath(project.path);
    return { kind: 'external' };
  }
  handle('project:reveal', revealProject);
  // This computer's file manager at an item's place, the item selected; the project root opens as the folder itself.
  async function revealEntry(id, relativePath) {
    const project = findProject(id);
    if (project.kind === 'ssh') throw new Error('远程项目的文件在服务器上，本机没有它的位置。');
    if (!relativePath) { await openPath(project.path); return; }
    shell.showItemInFolder(await resolveProjectPath(project, relativePath));
  }
  handle('project:reveal-entry', revealEntry);
  function setProgress(value) { fileProgress = value; send('files:progress', value); }
  return { setProgress };
}

module.exports = { registerFilesIpc };
