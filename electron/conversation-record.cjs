const { claudeOwnRecord } = require('./agent-actions.cjs');
const { messageText, promptText, promptCommand } = require('./prompt-queue.cjs');
// Keep terminal history and SDK replay on one provenance and wrapper rule.
const WRAPPERS = /<(system-reminder|environment_context|user_instructions|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook)\b[^>]*>[\s\S]*?<\/\1>/g;
const PASTED = /<\/?pasted_content\b[^>]*>\n?/g;
const clean = text => String(text || '').slice(0, 60000).replace(WRAPPERS, '').replace(PASTED, '').replace(/\[Image #\d+\]\s?/g, '').trim();
const claudeApiError = record => record?.type === 'assistant' && (record.isApiErrorMessage === true || typeof record.error === 'string');
function apiErrorText(record) {
  const text = clean(messageText(record.message?.content));
  // The terminal has no structured result/notice stream. Keep the CLI's readable notices, including reset words,
  // but never render a raw API error body or machine code as an assistant reply.
  if (/^(?:You've hit your limit|Not logged in|Credit balance is too low|Prompt is too long)\b/i.test(text) && !/[{}]/.test(text)) return text;
  if (/enforced_spend_limit_reached|You have reached your specified API usage limits/i.test(text)) return 'API 用量已达上限。';
  if (record.error === 'authentication_failed') return 'Claude 尚未登录或身份验证失败。';
  if (record.error === 'billing_error') return 'API 额度不足，需要充值后继续。';
  if (record.error === 'rate_limit') return 'API 请求受到限流。';
  if (/prompt.{0,12}too long|context.{0,12}(?:long|limit)/i.test(text)) return '输入超过上下文长度，本轮未能完成。';
  return 'API 请求失败，本轮未能完成。';
}
function claudeText(record) {
  if (!record || record.isSidechain || record.parent_tool_use_id || record.isMeta || record.is_meta || claudeOwnRecord(record) || claudeApiError(record)) return null;
  if (record.type === 'user') {
    const original = promptText(record.message?.content, record);
    return original === null ? null : promptCommand(original) || clean(original);
  }
  return record.type === 'assistant' ? clean(messageText(record.message?.content)) : null;
}
module.exports = { clean, claudeText, claudeApiError, apiErrorText };
