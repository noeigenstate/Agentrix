// Chinese words for the Claude reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/claude.cjs.
export const claudeWords: Record<string, string> = {
  'claude.not_found': '没有找到 Claude Code',
  'claude.too_old': 'Claude Code 版本太旧',
  'claude.cli_split_versions': '找到了几个不同版本的 Claude Code',
  'claude.timeout': '检查 Claude Code 超时',
  'claude.failed': '运行 Claude Code 失败',
  'claude.unreadable': '无法读取 Claude Code',
  'claude.billing_mismatch': '计费方式与所选的运行方式不一致',
  'claude.invalid_key': 'API 密钥无效',
  'claude.route_config': '线路设置有问题',
  'claude.native_cli_unverified': '还没有确认可用的 Claude Code，无法使用原生模式',
  'claude.credits_exhausted': '控制台的余额已用完，请先充值',
  'claude.rate_limited': '已触及服务商的速率限制，请稍后再试',
  'claude.account_limit': '账号或组织的花费上限已到',
};
