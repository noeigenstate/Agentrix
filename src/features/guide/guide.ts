// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "计费原因", text: "测试连接无法确认计费来源时，会写明原因，例如初始化超时、Claude Code 启动后退出（附错误输出），或者 Claude Code 报告了别的计费来源。" },
  { title: "启动原因", text: "原生会话启动失败时，卡片和转到终端的提示里都会写明具体原因；没有保存密钥时会直接说明。" },
  { title: "只用保存的密钥", text: "原生模式只用 Agentrix 里保存的 API 密钥，Claude Code 设置里的 apiKeyHelper 不会再让 API 通道无法使用；终端里的 Claude Code 不受影响。" },
];
