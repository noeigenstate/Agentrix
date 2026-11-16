// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "项目级 Agent 标签", text: "Agent 标签页列出项目里每个终端的 worker，并标明属于哪个终端。worker 一启动就有一行，写着「启动中 · 未确认」，15 秒还没确认会给出提示。" },
  { title: "最近完成与后台", text: "刚结束的 worker 收在「最近完成 N 个」里，保留最近 10 个、最长 30 分钟。Claude Code 的后台任务显示在「后台任务」组并带输出，有任务运行时项目头部和 Agent 标签页会写「后台 N 个运行中」。" },
  { title: "worker 不再丢失", text: "消息丢失或终端重启后，worker 的行仍然保留；被拒绝的 worker 会写明原因。Claude worker 跟随主终端的模式，原生模式下派出的 worker 不会退回订阅。" },
  { title: "SSH 速率能恢复", text: "SSH 项目里子代理的速率读取遇到文件消失或被占用时，会在下次读取时恢复，不再一直卡住。" },
  { title: "几处小修复", text: "一轮以 API 错误结束后，状态灯不再一直显示工作中；装在其他盘 pnpm 目录里的 Codex 也能被找到；Claude 工作时发送消息的几种边缘情况更稳。" },
  { title: "界面微调", text: "浅色主题的淡色文字更清晰，Codex 权限菜单里每项都有说明，小按钮统一为一种尺寸，窄输入框里的占位文字更短。" },
];
