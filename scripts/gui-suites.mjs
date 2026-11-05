import policy from './clipboard-policy.cjs';
// These six read or write the system clipboard and run only in GitHub Actions.
// Locally the default list skips them; naming one with --only is refused.
export const suites = ['smoke', 'restore-slow', 'session', 'completion', 'gpu-terminal', 'workspace', 'editor-terminals', 'themes-markdown', 'visual', 'navigation', 'git', 'cmd', 'clipboard', 'material', 'composer', 'reading', 'dashboard', 'native-question', 'native-session', 'native-session-runtime', 'reading-hierarchy', 'path-refresh'];
export const clipboardSuites = ['session', 'workspace', 'editor-terminals', 'clipboard', 'composer', 'gpu-terminal'];

// A local preflight sets CI=true too, so it must not admit clipboard suites.
export function selectSuites(argv, env) {
  const named = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',') : null;
  if (named?.some(name => !suites.includes(name))) throw new Error('Unknown GUI suite');
  const refused = (named ?? []).filter(name => clipboardSuites.includes(name));
  if (refused.length && !policy.githubActions(env)) throw new Error(`The suites ${refused.join(', ')}: ${policy.reason}`);
  const selected = named ?? suites, skipped = policy.githubActions(env) ? [] : selected.filter(name => clipboardSuites.includes(name));
  return { selected: selected.filter(name => !skipped.includes(name)), skipped };
}
