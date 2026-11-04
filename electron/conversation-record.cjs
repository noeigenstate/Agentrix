const { claudeOwnRecord } = require('./agent-actions.cjs');
const { messageText, promptText, promptCommand } = require('./prompt-queue.cjs');
// Keep terminal history and SDK replay on one provenance and wrapper rule.
const WRAPPERS = /<(system-reminder|environment_context|user_instructions|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
const PASTED = /<\/?pasted_content\b[^>]*>\n?/g;
const clean = text => String(text || '').slice(0, 60000).replace(WRAPPERS, '').replace(PASTED, '').replace(/\[Image #\d+\]\s?/g, '').trim();
function claudeText(record) {
  if (!record || record.isSidechain || record.parent_tool_use_id || record.isMeta || record.is_meta || claudeOwnRecord(record)) return null;
  if (record.type === 'user') {
    const original = promptText(record.message?.content, record);
    return original === null ? null : promptCommand(original) || clean(original);
  }
  return record.type === 'assistant' ? clean(messageText(record.message?.content)) : null;
}
module.exports = { clean, claudeText };
