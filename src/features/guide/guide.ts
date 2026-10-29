// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "界面缩放", text: "设置 › 外观里可以缩放界面，默认按当前显示器自动调整，也可选 80%–150%，文字和终端一起按同一比例缩放。" },
  { title: "技能管理", text: "设置新增「技能」页：系统自带的和你自己的技能分开管理，能看 Agent 改了什么、退回旧版，并显示最近一次生效。" },
  { title: "模型路由", text: "自带「模型路由」技能：Agentrix 启动的每个 Claude Code 和 Codex 会话都会遵循它分工，只装了一个 Agent 时也有对应安排。" },
  { title: "主模型任务", text: "主模型卡片直接显示正在处理的任务、计时、当前步骤和排队的任务，原来的「正在处理的任务」卡片并入其中。" },
  { title: "单独删图", text: "阅读视图输入框里粘贴的每张图片都有自己的移除按钮，删一张不影响其他图片和文字。" },
  { title: "官方图标", text: "选择助手时显示 Claude 和 Codex 的官方图标；Claude Code 项目里的列表圆点改用 Claude 的橙色。" },
  { title: "状态修正", text: "GPT 子代理显示 token/s，已停止的后台调用不再一直显示运行中，有命令失败时头像不再出现红圈。" },
];
