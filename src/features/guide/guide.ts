// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "统一接口", text: "每种 CLI 的差异收进一份能力清单和适配接口；以后接入新的 CLI 不必改通用代码，它不支持的功能会明确说明原因。" },
  { title: "干活标记", text: "路由栏里，有角色正在干活的座位会在模型名右侧显示一把敲打的小锤子。" },
  { title: "版本提示", text: "Claude Code 版本过旧时，运行中切换模型、深度、快速模式和 Ultracode 的控件会置灰并说明原因，不再悄悄失败。" },
  { title: "远端角色", text: "SSH 项目的总指挥现在可以调用角色：角色在远端主机的项目目录里运行，状态显示在活动栏。需要远端有 Node 20.3 和 Git 2.11 以上。" },
  { title: "远端同步", text: "指挥家模式下，SSH 远端的 Claude Code 也跟随总指挥座位的快速模式和 Ultracode。" },
  { title: "切换说明", text: "自动切换没能完成时，左栏和阅读视图会说明并提示手动切换，不再一直显示“正在切换”；新会话在第一轮之前显示“已就绪”。" },
  { title: "角色跑测试", text: "可写的 Claude 角色在命令行方式下也能运行命令和测试，仍不能提交、推送或强制回退。" },
  { title: "限流提示", text: "Codex 的限流提示只在请求确实被拒绝时显示，之后成功的一轮会清除它。" },
  { title: "远端 Claude", text: "SSH 项目的启动页现在也列出 Claude Code，点击后在远端终端里启动；选“继承开发历史”时由远端的 Claude Code 自己续接。" },
  { title: "远端切换", text: "指挥家模式下改总指挥座位，SSH 远端运行中的 Claude Code 也会自动切换模型和思考深度，改动的座位表随你的下一条消息告知模型。" },
  { title: "别名座位", text: "座位用 sonnet、opus 这类别名时，新版 Claude Code 的模型选择器按版本号列出模型也能选中，不再切换失败。" },
  { title: "远端续接", text: "SSH 项目里启动后没发过消息的 Codex 会话不再被当成历史，续接不到时“开始新的对话”直接新开；启动中和连接失败时发送有各自的提示。" },
  { title: "角色启动", text: "修复 Codex 角色在部分 Windows 环境报“沙箱尚未确认工作目录”而无法启动的问题。" },
];
