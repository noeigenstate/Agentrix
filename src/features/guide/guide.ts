// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new"; highlight?: true }[] = [
  {
    title: "面板简化", group: "new",
    text: "用量面板只显示通道和额度，打开项目就能看到额度，角色列表也和总指挥用同一种排法。",
  },
  { title: "agy 支持", text: "Google Antigravity CLI 可以用作原生主会话和派发角色。模型可在「模型分工」里选择，使用前请自行安装并登录 agy。" },
  { title: "看板简化", text: "数据看板按任务的测试结果显示各模型的可靠性。" },
  { title: "角色排序", text: "在「模型分工」里可以拖动角色卡片调整顺序。" },
  { title: "启动入口", text: "启动项目时，可以直接选择已安装的 Antigravity。" },
  { title: "技能归项目", text: "Agentrix 不再替你管理技能。技能放在每个项目自己的 skills 文件夹里，助手像读写其他项目文件一样读写它。", highlight: true },
  { title: "设置简化", text: "设置移除了技能页，技能开关、触发方式、版本记录和待确认修改也一并取消。" },
  { title: "内置规则", text: "Agentrix 启动会话时不再自动提供代码规范、界面规范和日常话回复这三份规则。" },
  { title: "旧技能", text: "旧的共用技能还在 Agentrix 数据目录的 skills 文件夹，之前因同名被移走的项目技能还在同一数据目录的 skill-replaced 文件夹。" },
  { title: "角色改动", text: "角色可以直接修改任务范围内的项目技能，改动会保存在项目文件里。" },
  { title: "分工照旧", text: "总指挥模式继续按你设定的角色和模型分派任务。" },
];
