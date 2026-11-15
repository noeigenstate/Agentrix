// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "不再有 API 预算", text: "Agentrix 不再设 API 预算。多个原生 API 会话可以同时运行，只受服务商的余额、配额或账号限额约束。" },
  { title: "服务商限额的提示", text: "服务商拒绝请求时，受影响的请求会停下并用一句话写明原因。触及速率限制只影响对应的卡片，限制结束后该卡片自动回到 API。" },
  { title: "API 花费一行", text: "活动面板里的「API 花费」一行显示今天和本月的花费，只供参考，不会限制使用。" },
  { title: "到处都能找到 Codex", text: "Codex 装在 npm 的各种目录、不在 PATH 里的 npm 前缀、Windows 保存的 PATH、官方安装器、WinGet、scoop、Chocolatey、Volta、nvm、fnm、VS Code 扩展或注册表里，都能被找到，最后还会在后台搜索本机磁盘；找到的必须能报出版本号。设置 › 编码助手会写明是怎么找到的，找不到时列出查找过的位置。" },
  { title: "各处用同一个 Codex", text: "终端、派出的 worker 和原生模式运行的是同一个 Codex，找到的位置会被记住，下次启动直接使用。" },
  { title: "状态汇报更快", text: "本机终端里的 Claude Code 通过本地连接向 Agentrix 汇报状态，不再每个事件启动一次 PowerShell（以前约 0.6 秒）。有代理接管这条连接时沿用旧方式并写明原因，SSH 项目不变。" },
  { title: "阅读视图收起交付", text: "阅读视图不再显示回复末尾的【交付】块，作业卡片仍会显示它；复制和引用取的是你看到的文字。" },
  { title: "排队消息更快", text: "Claude Code 工作时发送的消息会更早排进队列；必须等待时，输入框会写明原因。" },
];
