// Chinese words for the terminal reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/term.cjs.
export const termWords: Record<string, string> = {
  'term.waiting_permission': '终端正在等你确认权限',
  'term.waiting_question': '终端正在等你回答问题',
  'term.menu_open': '终端里打开了一个菜单，请先在终端里处理',
  'term.queued_behind_turn': '这条消息排在正在进行的一轮后面',
  'term.turn_running': '上一轮还在进行中',
  'term.cli_not_ready': '命令行工具还没有准备好接收输入',
  'term.input_has_draft': '输入框里还有没发送的内容',
  'term.receipt_missing': '命令行工具没有确认收到，消息未确认送达',
  'term.hooks_silent': '钩子已经一段时间没有回报',
  'term.hooks_down': '钩子通道不可用',
  'term.hooks_command_proxy': '检测到代理（{variable}，来自{source}），钩子改用命令方式',
  'term.hooks_command_ssh': 'SSH 终端的钩子使用命令方式',
  'term.transcript_behind': '会话记录落后于终端',
  'term.interrupted': '这一轮被中断了',
};
