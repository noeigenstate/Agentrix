// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "终端默认", text: "macOS 的终端现在默认启动 Bash，可在设置的「终端」里改回 zsh；原来用 zsh 的话，请把个人配置移到 ~/.bash_profile，或直接选 zsh。" },
  { title: "回答卡片", text: "助手需要你选择或回答问题时，阅读视图里会直接出现卡片，点选或填写后提交即可，不必再切到终端。" },
  { title: "数据看板", text: "Agentrix 菜单新增「数据看板」，在单独的窗口里查看各模型的任务表现和协作报告，并可采纳或不采纳调整建议。" },
  { title: "标题栏按钮", text: "macOS 窗口标题栏的红黄绿按钮右边现在是原生的「决策」和「工作台」按钮，样子和网页里的一致，全屏时也在。" },
  { title: "菜单栏", text: "macOS 屏幕顶部的菜单栏现在只剩 Agentrix 一个菜单，设置、数据看板等入口都收在里面。" },
  { title: "全屏", text: "macOS 全屏时窗口不再有自己的标题栏和「Agentrix」字样，按搜索会把它请回来；点红色关闭按钮会先退出全屏再隐藏，不再黑屏。" },
  { title: "打开文件", text: "结果卡片上的「打开文件」现在会直接打开文件，不再提示「无效的项目文件路径」。" },
];
