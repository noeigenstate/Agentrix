// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "标题栏居中", text: "macOS 窗口的红黄绿按钮和「决策」「工作台」现在在顶栏里上下居中，拖动窗口时也不再跳动。" },
  { title: "深色全屏", text: "深色主题下，macOS 全屏时顶部的系统栏是深色的，菜单和对话框也跟着主题走。" },
  { title: "模型路由", text: "自带的模型路由不再使用 GPT-6.1-Terra：界面验收和小任务改由 Sonnet 负责，只装了 Codex 时由 Sol 负责。" },
];
