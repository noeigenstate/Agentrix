const { spawnSync } = require('node:child_process');
function findPython(run = spawnSync) {
  for (const [command, args] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const probe = run(command, [...args, '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0 && probe.stdout.trim() === '3') return { command, args };
  }
  throw new Error('No Python 3 interpreter found (tried python3, python, and py -3).');
}
module.exports = { findPython };
