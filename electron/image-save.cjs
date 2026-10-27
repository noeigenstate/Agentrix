const path = require('node:path');

// The save dialog for a picture an agent generated: its own name in the pictures folder, filtered to its own type.
function saveDialogOptions(file, folder, label) {
  const extension = path.extname(file).slice(1).toLowerCase();
  return { defaultPath: path.join(folder, path.basename(file)), filters: [{ name: label, extensions: [extension] }] };
}

// Windows drops the extension of a name typed without one: the picture keeps the type it came with.
const saveTarget = (picked, file) => path.extname(picked) ? picked : picked + path.extname(file);

module.exports = { saveDialogOptions, saveTarget };
