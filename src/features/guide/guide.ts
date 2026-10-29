// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "进入会话", text: "鼠标移到项目卡片的标题栏上会显示「进入」，点击进入会话；菜单里的「全屏查看」改叫「进入会话」，不再和窗口全屏混淆。" },
  { title: "越界拦截", text: "派发子任务时可以限定它能改的文件；改了范围外的文件，调用的模型里会标出「越界」，悬停可看是哪些文件。" },
  { title: "共享账本", text: "同一任务的子任务共用一份账本：你定下的决定先交给每个子任务，子任务的发现写回账本，下一个接着用。" },
  { title: "接着做", text: "后续修改可以接回同一个子任务的会话，它记得刚才做过什么，不用重新解释。" },
  { title: "子任务常驻", text: "在普通终端里派发的子任务也显示在调用的模型里，主模型重启后也不会消失。" },
  { title: "模型路由", text: "内置的模型路由技能写明了何时限定文件范围、何时附上账本、何时接回会话。" },
  { title: "图标对齐", text: "活动面板里每行的图标和文字居中对齐。" },
];
