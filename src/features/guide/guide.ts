// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "拒后继续", text: "角色被拒绝某个操作后会继续完成其余工作，并在结果里列出被拒的操作，不再停下来等你确认。", group: "new" },
  { title: "模型版本", text: "模型路由里的 Claude 模型直接显示版本号，例如 Opus 5.5，不再显示“latest”；别名和它对应的版本只保留版本一项。", group: "new" },
  { title: "角色列表", text: "角色行用符号表示运行中、完成、失败、已停止和等你确认；模型核对一致时不再提示，路径保持一行。", group: "new" },
  { title: "主模型", text: "关闭指挥家模式后，左栏标题显示“主模型”；新选的模型与当前对话不同时，会提示它在新对话生效。", group: "new" },
  { title: "设置位置", text: "Agentrix 菜单里的“设置”移到了最下面。", group: "new" },
  { title: "忙时发送", text: "总指挥忙碌时从阅读视图发出的消息会像在终端里输入一样排进队列，不再卡住；等待期间会显示原因。" },
  { title: "角色不打扰", text: "角色不再弹出选项框或确认框等你作答：实现细节自己决定，需要拍板的事交回总指挥，被拒的操作连同原因列在结果里。" },
  { title: "派发更快", text: "交给角色的任务书更短，只带与任务相关的项目记忆；只读角色不再进入计划模式，角色状态的回报也更精简。" },
  { title: "自动清理", text: "角色的运行目录在结束七天后自动清理，不再在临时文件夹里越积越多。" },
  { title: "终端角色", text: "用 npm 方式安装的 Claude Code 在 PowerShell 里也能调用角色；SSH 终端会明确提示角色暂不可用。" },
  { title: "角色回退", text: "在 Windows 上还没完成 Codex 沙箱设置时，分给 Codex 的角色不再报错：Claude 做总指挥时改用总指挥的 Claude 模型运行并注明，Codex 做总指挥时提示它使用自带的子代理。" },
];
