// Which desktop suites windows-gui-smoke.mjs runs. These five read or write the system clipboard, so they run only on the remote CI machine (CI is set),
// never on a developer's computer: by default they are skipped there with the reason printed, and naming one with --only is refused.
export const suites = ['smoke', 'restore-slow', 'session', 'completion', 'gpu-terminal', 'workspace', 'editor-terminals', 'themes-markdown', 'visual', 'navigation', 'git', 'cmd', 'clipboard', 'material', 'composer', 'reading', 'dashboard', 'native-question', 'native-session', 'native-session-runtime', 'reading-hierarchy', 'path-refresh'];
export const clipboardSuites = ['session', 'workspace', 'editor-terminals', 'clipboard', 'composer'];

// { selected, skipped } for the command line; throws when a suite is unknown or a clipboard suite is named outside CI.
export function selectSuites(argv, env) {
  const named = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',') : null;
  if (named?.some(name => !suites.includes(name))) throw new Error('Unknown GUI suite');
  const refused = (named ?? []).filter(name => clipboardSuites.includes(name));
  if (refused.length && !env.CI) throw new Error(`The suites ${refused.join(', ')} use the system clipboard and run only on the remote CI (CI is not set here)`);
  const selected = named ?? suites, skipped = env.CI ? [] : selected.filter(name => clipboardSuites.includes(name));
  return { selected: selected.filter(name => !skipped.includes(name)), skipped };
}
