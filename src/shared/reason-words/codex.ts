// Chinese words for the Codex reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/codex.cjs.
export const codexWords: Record<string, string> = {
  'codex.not_found': '没有找到 Codex。已查找：{searched}；PATH 目录：{pathFolders}',
  'codex.incomplete': 'Codex 安装不完整',
  'codex.timeout': '检查 Codex 超时',
  'codex.failed': '运行 Codex 失败',
  'codex.unreadable': '无法读取 Codex',
  'codex.account_read_failed': '读取 Codex 账号失败',
};
