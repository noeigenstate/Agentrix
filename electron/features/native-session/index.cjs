const path = require('node:path');
const { createSettings } = require('./settings.cjs');
const { createRouter } = require('./router.cjs');
const { registerIpc } = require('./ipc.cjs');
function createNativeSessions(options) {
  const settings = createSettings(path.join(options.directory, 'settings.json'));
  const router = createRouter({ ...options, settings });
  return { ...router, getSettings: settings.get, register: handle => registerIpc({ handle, router, settings, claude: options.claude }) };
}
module.exports = { createNativeSessions };
