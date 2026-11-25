const { hookHarness } = require('./hook-harness.cjs');

function conversationView(overrides = {}, hooks = {}) {
  return hookHarness('src/features/reading/ConversationFeed.tsx', {
    '@phosphor-icons/react': new Proxy({}, { get: () => () => null }),
    './i18n': { t: text => text }, './UserAvatar': {}, './model-name.ts': {}, './lead-routing-notices.ts': {},
    './action-text': {}, './file-popup.ts': {}, './delivery.ts': require('../../src/features/home/delivery.ts'),
    './Markdown': { Markdown: () => null }, './PathText': {}, './useReadingPaths': {},
    './reply-links.ts': {}, './reading-paths': {}, './PendingPromptEntries': {}, './MessageMenu': {}, './Timeline': {},
    './ResultCard': {}, './result-round': {}, './FileCards': {}, './reply-files': require('../../src/features/reading/reply-files.ts'),
    './useVisibleTail': {}, ...overrides,
  }, hooks);
}

module.exports = { conversationView };
