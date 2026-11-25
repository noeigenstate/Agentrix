// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new"; highlight?: true }[] = [
  { title: "请更新", text: "请把 Claude Code 更新到最新版本。版本太旧时，开发角色可能停在一个看不见的确认框上，一直等着。", highlight: true },
  { title: "角色对话框", text: "右侧窗口里不再显示“简报”和“日志”两个展开项，更紧凑。" },
  { title: "角色交结果", text: "角色完成时用一个工具交回答案、待你决定的事、待批准的操作和发现，总指挥按字段读取，不再靠识别回复里的标题。" },
  { title: "结构化通道", text: "Agentrix 各部分之间传递的座位、模式、启动参数、派发状态和事件都改成带版本的字段格式，换写法或升级时不会再悄悄失效。" },
  { title: "角色卡", text: "活动栏的角色卡把模型标识放在座位名后面，去掉工作目录路径，任务标题改为灰色小字。" },
  { title: "锤子动画", text: "路由栏的小锤子按 Agentrix 的界面动画设置敲打，Windows 关闭动画效果时不再停住不动。" },
  { title: "团队记录", text: "团队的记忆改由结构化记录保存并渲染成文档，原有内容首次读取时自动导入，原文件留作备份。" },
];
