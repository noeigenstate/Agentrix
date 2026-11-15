// Chinese words for the dispatcher reason codes (C-1), one phrase per code. The window picks the phrase by code and fills its {param}
// placeholders from the reason; English comes from electron/locales/en.json by the same phrase. Plain strings, so the
// main process never builds a sentence. Keep this table equal to electron/shared/reasons/dispatch.cjs.
export const dispatchWords: Record<string, string> = {
  'dispatch.bootstrap_missing': '派发助手找不到启动文件',
  'dispatch.bootstrap_invalid': '派发助手的启动文件无法使用',
  'dispatch.pipe_unreachable': '派发助手连不上 Agentrix',
  'dispatch.pipe_timeout': '派发助手连接 Agentrix 超时',
  'dispatch.session_mismatch': '派发事件来自另一个会话，已拒绝',
  'dispatch.project_mismatch': '派发事件不属于这个项目，已拒绝',
  'dispatch.invalid_event': '收到格式不对的派发事件，已拒绝',
  'dispatch.oversize_event': '收到过大的派发事件，已拒绝',
  'dispatch.unknown_run': '收到未登记的派发运行的事件，已拒绝',
  'dispatch.late_after_end': '收到运行结束之后的派发事件，已拒绝',
  'dispatch.gap_recovered': '漏掉的派发事件已从记录里补齐',
  'dispatch.outbox_unreadable': '无法读取派发记录',
  'dispatch.control_timeout': '派发控制通道超时',
  'dispatch.control_unbound': '派发控制通道没有对应的团队或运行',
  'dispatch.control_disconnected': '派发控制通道已断开',
  'dispatch.helper_gone': '派发助手已经退出',
  'dispatch.intercept_unsupported': '没有通过派发运行：不支持选项 {option}，等价命令：{equivalent}',
  'dispatch.intercept_nested': '子任务里不能再直接启动模型，请通过派发请求',
  'dispatch.delegation_refused': '子任务请求被拒绝（规则：{rule}）',
  'dispatch.delegation_waiting_lead': '子任务请求在等主持人批准',
  'dispatch.parent_ended': '上级运行已结束，子任务随之停止',
};
