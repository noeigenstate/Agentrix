// Chinese words for the Codex reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/codex.cjs.
export const codexWords: Record<string, string> = {
  // The places themselves ({searched}) are listed one to a line under this sentence, so it does not carry them.
  'codex.not_found': '没有找到 Codex。已查找 PATH 里的 {pathFolders} 个目录，以及以下位置。',
  'codex.incomplete': 'Codex 安装不完整',
  // The next three are shown under a found Codex whose version check printed nothing: it is still the file in use.
  'codex.timeout': 'Codex 没有在限定时间内报告版本号',
  'codex.failed': 'Codex 没有报告版本号：运行它时出错',
  'codex.unreadable': 'Codex 没有报告版本号：输出里没有版本号',
  'codex.account_read_failed': '读取 Codex 账号失败',
};
