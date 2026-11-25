const { hookHarness } = require('./hook-harness.cjs');
const { elements } = require('./renderer-fixtures.cjs');

function settingsView(t) {
  const AgentRuntimeSettings = () => null;
  const view = hookHarness('src/features/settings/SettingsDialog.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }), './i18n': { t: text => text, currentLanguage: () => 'en' },
    './VoiceButton': {}, './shortcuts': { shortcut: () => '' }, './ShortcutSettings': {}, './AgentsSettings': {},
    './AgentRuntimeSettings': { AgentRuntimeSettings }, './platform': {}, './TerminalFontSettings': {}, './UserAvatarSetting': {},
    './ThemeSetting': {}, './Select': {}, './SkillsSettings': {}, './ProjectImagesSettings': {}, './AboutSettings': {},
  });
  t.after(() => view.dispose());
  const render = props => elements(view.render('SettingsDialog', { ...props, settings: { glassTransparency: null, ...props.settings } }).result);
  return { render, AgentRuntimeSettings };
}

module.exports = { settingsView };
