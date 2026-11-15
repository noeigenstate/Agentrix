// Chinese words for the terminal reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/term.cjs.
export const termWords: Record<string, string> = {
  'term.waiting_permission': '{agent} 正在等待你确认权限。请先在终端中处理，再发送这条消息。',
  'term.waiting_question': '{agent} 正在等待你回答问题。请先在终端中回答。',
  'term.menu_open': '终端中打开了菜单。请先关闭菜单，再发送这条消息。',
  'term.reported_waiting': '{agent} 已报告正在等待回答。请先在终端中作答。',
  'term.popup_open': '终端弹窗已打开。请先处理或关闭弹窗，再发送这条消息。',
  'term.queued_behind_turn': '{agent} 已将这条消息排队，会在当前工作结束后读取。',
  'term.turn_running': '上一轮还在进行中',
  'term.cli_not_ready': 'Agentrix 尚未确认终端可以安全接收输入，因此还没有发送这条消息。',
  'term.input_has_draft': '终端输入框中还有未发送的草稿。请先发送或清空草稿。',
  'term.receipt_missing': '这条消息是否送达尚未确认。请先检查终端，再决定是否重新发送。',
  'term.hooks_silent': '钩子已经一段时间没有回报',
  'term.hooks_down': '钩子通道不可用',
  'term.hooks_command_proxy': '检测到代理（{variable}，来自{source}），钩子改用命令方式',
  'term.hooks_command_ssh': 'SSH 终端的钩子使用命令方式',
  'term.transcript_behind': '会话记录落后于终端',
  'term.interrupted': '这一轮被中断了',
};
