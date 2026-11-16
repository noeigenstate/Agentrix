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
  'claude.no_key': '还没有保存 API key',
  'claude.invalid_key': 'API 密钥无效',
  'claude.key_forbidden': 'API 密钥没有调用权限。',
  'claude.api_unreachable': '无法连接 Anthropic API。',
  'claude.key_check_failed': '无法完成 API 连接检查。',
  'claude.native_cli_required': '未找到原生 Claude Code，无法通过 API 运行',
  'claude.cli_too_old': 'Claude Code 版本过低，请升级到 2.1.317 或更高',
  'claude.billing_identity_mismatch': 'Claude Code 没有使用这个密钥',
  'claude.billing_unconfirmed': '无法确认 Claude Code 的计费来源',
  'claude.api_unavailable': 'Claude API 路径当前不可用。',
  'claude.terminal_selected': '按设置使用终端',
  'claude.set_terminal': '按设置使用终端',
  'claude.set_api': '按设置只用 API',
  'claude.route_config': '线路设置有问题',
  'claude.native_cli_unverified': '还没有确认可用的 Claude Code，无法使用原生模式',
  'claude.credits_exhausted': '控制台的余额已用完，请先充值',
  'claude.rate_limited': '已触及服务商的速率限制，请稍后再试',
  'claude.account_limit': '账号或组织的花费上限已到',
};
