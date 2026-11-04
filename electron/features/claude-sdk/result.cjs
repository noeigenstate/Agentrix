const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const reasons = {
  completed: ['completed', '本轮已完成。'],
  blocking_limit: ['interrupted', '本轮因服务用量限制而停止。'],
  rapid_refill_breaker: ['interrupted', '请求过于频繁，本轮已停止。'],
  prompt_too_long: ['failed', '输入超过上下文长度，本轮未能完成。'],
  image_error: ['failed', '图片无法处理，本轮未能完成。'],
  model_error: ['failed', '模型返回错误，本轮未能完成。'],
  api_error: ['failed', 'API 请求失败，本轮未能完成。'],
  malformed_tool_use_exhausted: ['failed', '工具调用格式多次无效，本轮已停止。'],
  aborted_streaming: ['interrupted', '回复已中断。'],
  aborted_tools: ['interrupted', '工具执行已中断。'],
  stop_hook_prevented: ['interrupted', '结束钩子阻止了完成，本轮已暂停。'],
  hook_stopped: ['interrupted', '钩子停止了本轮执行。'],
  tool_deferred: ['interrupted', '这次工具调用被钩子推迟，没有执行。'],
  max_turns: ['interrupted', '已达到本轮最大执行次数。'],
  background_requested: ['interrupted', '本轮已转入后台，尚未完成。'],
  budget_exhausted: ['interrupted', '本轮 API 预算上限已用完。'],
  structured_output_retry_exhausted: ['failed', '结构化输出重试次数已用完。'],
  tool_deferred_unavailable: ['failed', '工具无法延期执行，本轮已停止。'],
  turn_setup_failed: ['failed', '本轮初始化失败。'],
};
function tokensOf(usage) {
  if (!usage) return null;
  return { input: count(usage.input_tokens), cachedInput: count(usage.cache_read_input_tokens), cacheWrite: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens), reasoning: null };
}
function turnResult(result, { interrupted = false, costUsdMicros = null } = {}) {
  const reason = Object.hasOwn(reasons, result.terminal_reason) ? result.terminal_reason
    : result.terminal_reason ? 'unknown' : result.deferred_tool_use ? 'tool_deferred'
      : ({ error_max_budget_usd: 'budget_exhausted', error_max_turns: 'max_turns', error_max_structured_output_retries: 'structured_output_retry_exhausted' }[result.subtype] || null);
  let [status, message] = reasons[reason] || ['interrupted', '本轮已结束，未提供可识别的结束原因。'];
  if (interrupted) { status = 'interrupted'; message = '本轮已中断。'; }
  else if (result.is_error && (status === 'completed' || !reason || reason === 'unknown')) { status = 'failed'; message = 'Claude 执行失败。'; }
  return { status, error: status === 'completed' ? null : message, terminalReason: reason, message,
    durationMs: count(result.duration_ms), apiDurationMs: count(result.duration_api_ms), costUsdMicros: count(costUsdMicros), costEstimated: true,
    tokens: tokensOf(result.usage) };
}
module.exports = { turnResult, tokensOf, reasons };
