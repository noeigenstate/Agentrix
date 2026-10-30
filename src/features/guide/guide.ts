// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "圆桌会议", text: "分派子任务前可以先开圆桌会：每个子模型复述自己的任务，主模型逐条答复，大家确认后才开工；会议纪要以两张表给你看（网页和 Markdown）。" },
  { title: "共享项目记忆", text: "同一仓库的子模型共享一份项目记忆：开工时都能看到上一轮的整理、其他子模型的发现、此刻谁在改哪些文件；两个子任务改同一批文件会被拦下。" },
  { title: "每轮整理", text: "一轮开发结束后，主模型把结果和架构调整写进项目记忆；没整理完不能开下一轮的圆桌会。" },
  { title: "界面", text: "主模型卡片在还没开始任何一轮时不再显示「等待下一步」。" },
];
