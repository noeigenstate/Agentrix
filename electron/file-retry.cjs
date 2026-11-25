const waitCell = new Int32Array(new SharedArrayBuffer(4));
const readErrors = new Set(['EBUSY', 'EPERM', 'EMFILE']);
const windowsErrors = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

function retryFileOperation(operation, { read = false, platform = process.platform } = {}) {
  const retryable = read ? readErrors : platform === 'win32' ? windowsErrors : null;
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (attempt >= 4 || !retryable?.has(error.code)) throw error;
      Atomics.wait(waitCell, 0, 0, (attempt + 1) * 10);
    }
  }
}

module.exports = { retryFileOperation };
