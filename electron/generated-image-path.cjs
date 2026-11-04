const path = require('node:path');
const GENERATED = /[\\/]generated_images[\\/][^\\/]+[\\/][^\\/]+\.(?:png|jpe?g|webp)$/i;
// Codex records the path on the system it runs on; either form of an absolute path is read the same way everywhere.
const isGeneratedImage = file => typeof file === 'string' && !/^(?:[\\/]{2}|file:)/i.test(file) && (path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) && GENERATED.test(file);
module.exports = { isGeneratedImage };
