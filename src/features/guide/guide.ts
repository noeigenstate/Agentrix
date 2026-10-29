// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "代码规范", text: "自带「代码规范」技能：第一次在项目里启动会话时先审查代码、给出分阶段计划，你同意后才动手；之后每次改代码都遵循它。" },
  { title: "触发时机", text: "技能有始终、按需、首次打开项目三种触发方式；项目里已有同名技能时，以项目自己的版本为准。" },
  { title: "技能页", text: "SKILL.md 渲染成排版后的正文，可切换源码；依赖写明 Codex 或 Claude Code 至少装一个。" },
  { title: "主模型状态", text: "主模型卡片只跟主模型这一轮：由后台结果唤起的一轮会写明在处理哪个结果，结束即停，不再停留在「正在处理」。" },
  { title: "思考深度", text: "每个模型的标题行显示思考深度和输出模式，Claude 子代理也有；不再重复显示「子代理」和官方服务商。" },
  { title: "派发确认", text: "主模型派出的 Codex 和 Claude 子任务由派发助手启动：开始时确认模型路由，运行中每 5 秒更新 token/s，完成后显示已完成并在 3 秒后移除。" },
  { title: "图标等大", text: "OpenAI 和 Claude 的图标在各处显示同样大小。" },
];
