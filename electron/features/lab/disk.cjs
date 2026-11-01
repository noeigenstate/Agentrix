// Lab data and dependency trees are physical files, including *.asar. Never use Electron's archive-aware fs here.
const disk = process.versions.electron ? require('original-fs') : require('node:fs');
const fs = disk.promises;
const REMOVE_OPTIONS = Object.freeze({ recursive: true, force: true, maxRetries: 8, retryDelay: 75 });

async function removePath(file) {
  try { await fs.rm(file, REMOVE_OPTIONS); }
  catch (error) { error.infrastructure = true; throw error; }
}

module.exports = { fs, removePath, cloneMode: disk.constants.COPYFILE_FICLONE };
