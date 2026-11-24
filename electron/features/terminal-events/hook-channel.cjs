const { adapterOf } = require('../cli-adapters/registry.cjs');

const { HTTP_EVENTS, COMMAND_KINDS, proxyOf, terminalHooks, downgradeHooks } = adapterOf('claude').events.hooks;

// The terminal's channel follows each claude launch: the wrapper's hook-channel report (shell event N) downgrades the launch
// it precedes (codex-started N + 1), and a launch that follows none (no proxy this time) uses the terminal's own channel
// again. The two arrive on separate pipe connections in either order, so they are paired by sequence: a report older than
// the launch already started is a past launch's and changes nothing. `s` is the terminal's session record.
function reportHookChannel(s, variable, sequence) {
  s.hooksBase ||= s.hooks; s.hookReportSequence = sequence;
  const pastLaunch = sequence < s.hookLaunchSequence - 1;
  if (!pastLaunch) s.hooks = downgradeHooks(s.hooks, variable);
}
function startHookLaunch(s, sequence) {
  s.hookLaunchSequence = sequence;
  if (s.hooksBase && s.hookReportSequence !== sequence - 1) s.hooks = s.hooksBase;
}

module.exports = { HTTP_EVENTS, COMMAND_KINDS, proxyOf, terminalHooks, downgradeHooks, reportHookChannel, startHookLaunch };
