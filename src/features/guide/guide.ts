// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "强制调度", text: "Claude Code 或 Codex 在会话里用自己的命令行工具再启动 Codex 或 Claude 时，现在会经过调度器，显示为带「自启动」标记和速率的 worker 行，不再暗中运行。这样的调用默认只读，除非它要求写入权限；你自己在终端或用 ! 输入的命令照旧运行真正的命令行。" },
  { title: "Claude 子代理行", text: "Claude Code 用 Agent 工具启动的子代理，在终端和原生模式里都会从启动那一刻起显示为一行。继续的子代理标「继续」；按 Esc 或停止的记为已停止，不再算成功；后台子代理按 Esc 也不会被打断。" },
  { title: "Claude 路径统一", text: "连接测试和下一个新会话现在总是走同一条路径、用同一种计费。修好 Claude Code 的设置文件后，下一个新会话就生效，不必重启 Agentrix；「余额不足」的结果对所有项目里的 API key 都适用；Claude Code 缺失或版本太旧时，新会话会说明情况和原因。" },
  { title: "终端状态更稳", text: "迟到或重复的事件不会再让 Claude 终端的状态倒退。有消息排队时，Claude 的「Press up to edit queued messages」占位提示不再被当成你输入的文字。" },
  { title: "虚拟实验室调度", text: "调度助手在 Windows 和 macOS 的虚拟实验室里又能正常加载了。" },
];
