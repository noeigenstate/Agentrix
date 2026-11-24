// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "远端 Claude", text: "SSH 项目的启动页现在也列出 Claude Code，点击后在远端终端里启动；选“继承开发历史”时由远端的 Claude Code 自己续接。" },
  { title: "远端切换", text: "指挥家模式下改总指挥座位，SSH 远端运行中的 Claude Code 也会自动切换模型和思考深度，改动的座位表随你的下一条消息告知模型。" },
  { title: "别名座位", text: "座位用 sonnet、opus 这类别名时，新版 Claude Code 的模型选择器按版本号列出模型也能选中，不再切换失败。" },
  { title: "远端续接", text: "SSH 项目里启动后没发过消息的 Codex 会话不再被当成历史，续接不到时“开始新的对话”直接新开；启动中和连接失败时发送有各自的提示。" },
  { title: "角色启动", text: "修复 Codex 角色在部分 Windows 环境报“沙箱尚未确认工作目录”而无法启动的问题。" },
];
