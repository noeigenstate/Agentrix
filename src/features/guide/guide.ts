// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: '主模型', text: '活动栏顶部显示主 Agent 实际在用的模型、它此刻在做的步骤，以及实时的平均速率（xx token/s）。' },
  { title: '子代理速率', text: '「调用的模型」里每组都标明「子代理」，并显示各自的 token/s；子代理和主模型的记录分开计算，互不混入。' },
  { title: 'Claude 额度', text: 'Claude 终端运行时，活动栏里的额度会自己更新，不用再输入 /usage；查询不往终端输入任何内容，不打断正在运行的项目。' },
  { title: '任务列表', text: '任务做完立即从「正在处理的任务」里移除；后台通知触发的回复不再让旧任务一直挂着。' },
  { title: '后台 Codex', text: '「调用的模型」能显示在后台运行的 Codex 调用，跑完后才转入审核。' },
  { title: '阅读视图', text: '完成的结果标题不再带「· 已完成」；失败和中断照常标明。' },
  { title: '快捷键', text: '用快捷键切换项目时不再出现重点色边框。' },
];
