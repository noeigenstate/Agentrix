const path = require('node:path');
const { claudeConversation } = require('../../conversation.cjs');
const { ClaudeImageLine } = require('../../oversized-record.cjs');
const { promptText } = require('../../prompt-queue.cjs');
const { claudeSettings, claudeFastModeEcho } = require('../agents/agent-settings.cjs');
const { root, sessions } = require('./transcript-files.cjs');
const { completion, nativeCompletion, done, isServiceCommand } = require('./transcript-completion.cjs');

const { claudeConfigDir: home, findClaudeSession: find, listClaudeSessions } = sessions;

async function list(cwd, directory = home()) {
  const sources = [];
  for (const { id } of await listClaudeSessions(cwd, null, directory).catch(() => [])) {
    const filename = await find(cwd, id, directory).catch(() => null);
    if (filename) sources.push({ id, filename });
  }
  return sources;
}

function validate({ threadId, filename }, header) {
  const reported = /"sessionId"\s*:\s*"([\w-]+)"/.exec(header.toString('utf8'))?.[1];
  return path.basename(filename) === `${threadId}.jsonl` && (!reported || reported === threadId);
}

function record(value) {
  const prompt = value.type === 'user' ? promptText(value.message?.content, value) : null;
  const settings = claudeSettings(value);
  const usage = !value.isSidechain && value.type === 'assistant' && value.message?.model !== '<synthetic>' ? value.message?.usage : undefined;
  return { settings, usage, prompt, ...done(value) };
}

const activity = { bound: (s, restore) => s.claudeSessionId || (restore ? s.claudeResumeId : undefined) };

module.exports = { home, root, find, list, validate, record, conversation: claudeConversation, oversizedLine: ClaudeImageLine,
  sessions, activity, fastModeEcho: claudeFastModeEcho, completion, nativeCompletion, isServiceCommand };
