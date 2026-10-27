const { waitFor } = require('../../scripts/wait.mjs');

function cleanupTerminal(t, terminal) {
  let exited = false;
  const listener = terminal.onExit(() => { exited = true; });
  t.after(async () => {
    try {
      // A passed test must also reap its isolated shell; SIGHUP alone can leave the worker alive.
      if (!exited) terminal.kill('SIGKILL');
      await waitFor(() => exited, 'isolated terminal exit', 5000);
    } finally {
      listener.dispose();
    }
  });
}

module.exports = { cleanupTerminal };
