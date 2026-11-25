const { createContext } = require('react');
const { hookHarness } = require('./hook-harness.cjs');
const { elements, stubGlobals } = require('./renderer-fixtures.cjs');

function appView(t, { project = { id: 'p', name: 'Fixture', terminals: [] }, bridge = {}, ...overrides } = {}) {
  const noop = () => {};
  const SettingsDialog = () => null, AgentSidebar = () => null, ProjectExplorer = () => null;
  const listeners = new Map(), workspace = { projects: [project], settings: {} };
  const subscribe = () => noop, answer = async () => ({ ok: true });
  let view;
  stubGlobals(t, {
    document: { addEventListener: noop, removeEventListener: noop },
    window: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: noop, agentrix: {
      onState(fn) { fn(workspace); return noop; },
      onFocusProject: subscribe, onError: subscribe, onUpdateState: subscribe, onAgents: subscribe,
      onFullScreen: subscribe, onSSHAuth: subscribe, onEditorClose: subscribe, onDecisionShow: subscribe,
      isFullScreen: answer, getSSHAuth: answer, getAgents: answer, getUpdateState: answer, getState: answer, ...bridge,
    } },
  }, () => view?.dispose());
  view = hookHarness('src/App.tsx', {
    '@xterm/xterm': {}, '@phosphor-icons/react': new Proxy({}, { get: () => noop }),
    './ProjectSwitchHud': { ProjectSwitchHud: noop }, './ProjectExplorer': { ProjectExplorer },
    './AgentCalls': { AgentTabScope: createContext(null) }, './ActivityPane': { SeatsHost: noop }, './AgentSidebar': { AgentSidebar },
    './worker-menu-screen': {}, './AddProjectDialog': {}, './SSHAuthDialog': {},
    './useProjectReorder': { useProjectReorder: () => ({}) }, './subagent-splits': { pruneSplits: noop },
    './terminal-popup': { pruneReadingCli: noop }, './reading-mode': {},
    './useProjectFocusMotion': { useProjectFocusMotion: () => ({ focusedId: project.id, focus: noop }) },
    './useWorkspaceAppearance': { useWorkspaceAppearance: noop }, './VoiceButton': { VoiceOverlay: noop },
    './i18n': { t: text => text, applyLanguage: noop }, './platform': {}, './shortcuts': { applyShortcuts: noop, shortcut: noop },
    './grid-navigation': { gridColumns: () => 1 }, './voice-input': {}, './UsageGuide': {}, './GuideTour': {},
    './AppMenu': { AppMenu: noop }, './native-style': { useNativeTitlebarStyle: noop }, './IconButton': { IconButton: noop },
    './ModeSwitch': { ModeSwitch: noop }, './file-popup': { usePopup: noop }, './ProjectPanel': { ProjectPanel: noop },
    './SettingsDialog': { SettingsDialog }, './DecisionHome': {}, './decisions': { useDecisions: () => ({ decisions: [], snoozed: 0 }) },
    './app-commands': {}, './open-decision': {}, './DecisionCard': {}, ...overrides,
  });
  const render = () => elements(view.render('App').result);
  render();
  return { render, listeners, SettingsDialog, AgentSidebar, ProjectExplorer, project };
}

module.exports = { appView };
