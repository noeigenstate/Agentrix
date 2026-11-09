// A local view of provider-reported state. Missing values remain unknown; token
// counts are never estimated from text or summed twice with reasoning tokens.
function statusText({ options, thread, cwd, usage, account, limits, errors }, t = value => value) {
  const unknown = t('未知'), number = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : unknown;
  const line = (name, value) => `${t(name)}：${value ?? unknown}`;
  const tier = typeof options.fast === 'boolean' ? options.fast : ['fast', 'priority'].includes(thread.serviceTier) ? true : thread.serviceTier === 'default' ? false : null;
  const total = Number.isSafeInteger(usage?.input) && Number.isSafeInteger(usage?.output) ? usage.input + usage.output : null;
  const rows = [t('Codex 本地状态'), line('模型', options.model), line('思考强度', options.effort), line('快速模式', tier === null ? unknown : t(tier ? '开' : '关')),
    line('审批', typeof thread.approvalPolicy === 'string' ? thread.approvalPolicy : thread.approvalPolicy?.granular ? t('细分审批') : null),
    line('沙箱', thread.sandbox?.type), line('工作目录', cwd), line('模型服务来源', thread.modelProvider),
    line('账号', account?.kind === 'api' ? 'API' : account?.kind === 'subscription' ? t('订阅') : account?.kind === 'none' ? t('未连接') : unknown),
    line('本会话 token', number(total)), line('输入 token', number(usage?.input)), line('输出 token', number(usage?.output)),
    line('缓存输入 token', number(usage?.cachedInput)), line('推理 token', number(usage?.reasoning)),
    line('上下文', `${number(usage?.contextTokens)} / ${number(usage?.contextWindow)}`)];
  const buckets = limits?.limitsById || {};
  const windows = (buckets.codex ? [buckets.codex] : Object.values(buckets)).flatMap(bucket => [bucket?.primary, bucket?.secondary]).filter(Boolean);
  for (const [minutes, name] of [[300, '5 小时额度'], [10080, '每周额度']]) {
    const window = windows.find(value => value.windowDurationMins === minutes);
    const percent = Number.isFinite(window?.usedPercent) ? t('已用 {value}%').replace('{value}', String(window.usedPercent)) : unknown;
    const date = Number.isSafeInteger(window?.resetsAtMs) && window.resetsAtMs >= 0 ? new Date(window.resetsAtMs) : null;
    const pad = value => String(value).padStart(2, '0');
    const reset = date && Number.isFinite(date.getTime())
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : unknown;
    rows.push(line(name, `${percent}；${t('重置时间')}：${reset}`));
  }
  for (const [method, error] of errors) {
    const reason = Number.isInteger(error.code) ? `RPC ${error.code}` : t(['timeout', 'rpc_timeout'].includes(error.code) ? '请求超时' : ['closed', 'disconnected', 'process_exited'].includes(error.code) ? '连接已断开' : '读取失败');
    rows.push(`${method}：${t('读取失败')}（${reason}）`);
  }
  return rows.join('\n');
}
module.exports = { statusText };
