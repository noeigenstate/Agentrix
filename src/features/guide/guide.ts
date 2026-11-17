// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "语音输入不再误发", text: "听写后按回车、再点麦克风或再按 Ctrl+T，文字都会放进输入框，不会直接发送，要发送请自己按回车。在没有输入框的终端里，文字会被粘贴进去，不会按任何键。" },
  { title: "Codex 进程清理", text: "Windows 上，关闭或切换原生模式的 Codex 会话时，它启动的所有进程都会结束，不再有残留进程占住项目文件夹；读取账号信息时也同样清理。" },
  { title: "worker 不进历史", text: "重启后，worker 的对话不再出现在项目的 Claude 历史里，所以在你自己的终端里选择“继续”不会再接上 worker 的对话。" },
];
