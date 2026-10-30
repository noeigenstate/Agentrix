// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "代码规范", text: "每个任务开始前都会先读代码规范技能；它在项目里第一次运行时仍只审查一次现有代码，1.3.20 里审查过的项目不会再问。" },
  { title: "模型路由", text: "改为按需自动生效：只有比快速问答或一行修改更大的任务才会先读这个技能。" },
  { title: "界面规范", text: "新增的系统技能，设计、实现或审查界面时自动生效：先出设计稿，再按量化问题和灰度清单验收。" },
  { title: "系统技能", text: "详情里不再有「变更」页，每个版本的改动写在这里的更新说明里。" },
  { title: "重置次数", text: "打开项目时会主动查一次 Codex 剩余重置次数，不用先开始会话；查不到时分别显示查询中、未提供次数或暂不支持，不再一律显示次数未知。" },
  { title: "标题栏", text: "项目卡片标题栏去掉「进入」按钮，悬停时提示「进入会话，按住可拖动」。" },
];
