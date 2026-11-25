const { hookHarness } = require('./hook-harness.cjs');
const { elements, stubGlobals } = require('./renderer-fixtures.cjs');

function explorerView(t) {
  const focus = [], noop = () => {};
  const view = hookHarness('src/features/files/ProjectExplorer.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => noop }),
    './file-icons': {}, './entry-noise': {}, './ExplorerFileActions': { useExplorerFileActions: () => ({}) },
    './tree-reveal.ts': { useTreeReveal: noop }, './GitPanel': { GitBadge: noop, GitPanel: noop },
    './git-status': { gitDecorations: () => new Map() }, './useGitStatus': { useGitStatus: () => ({}) },
    './shortcuts': { shortcut: noop }, './i18n': {
      t: (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key]),
    },
  });
  stubGlobals(t, { window: {
    addEventListener: noop, removeEventListener: noop,
    agentrix: { fileTreeFocus: (...args) => focus.push(args) },
  } }, () => view.dispose());
  const project = { id: 'p', name: 'Fixture', path: '/project', kind: 'local' };
  const render = props => elements(view.render('ProjectExplorer', { project, expandedPaths: [], onCollapse: noop, ...props }).result);
  return { focus, render };
}

module.exports = { explorerView };
