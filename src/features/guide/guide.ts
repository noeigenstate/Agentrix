// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "状态汇报更快", text: "本机终端里，Claude Code 现在通过本地连接把状态（工作中、等待授权、完成）告诉 Agentrix。以前每个事件都要启动一次 PowerShell，约需 0.6 秒。现在等待提示灯和一轮的结束更快跟上命令行，Claude Code 在步骤之间也不再等 Agentrix。", group: "new" },
  { title: "有代理时沿用旧法", text: "如果代理（HTTP_PROXY 或 HTTPS_PROXY）会接管这条本地连接，终端会沿用原来的方式（在 Windows 上，状态汇报在后台运行），并写明原因。SSH 项目不变。", group: "new" },
  { title: "不再有 API 预算", text: "Agentrix 不再设 API 预算：月预算、预留额度和单轮上限都已取消。多个原生 API 会话可以同时运行，只受服务商的余额、配额或账号限额约束。" },
  { title: "服务商限额的提示", text: "服务商拒绝请求时（余额用完、账号花费上限已到），受影响的请求会停下并用一句话写明原因，并按设置转到终端。触及速率限制只影响对应的卡片，限制结束后该卡片自动回到 API。" },
  { title: "API 花费一行", text: "活动面板里的「API 花费」一行显示今天和本月的花费，只供参考，不会限制使用。" },
  { title: "到处都能找到 Codex", text: "Codex 装在其他磁盘、npm 的各种目录结构、不在 PATH 里的 npm 前缀、系统保存的 Windows PATH、官方安装器或 WinGet 里，都能被找到。设置 › 编码助手会写明是怎么找到的，找不到时会逐项列出查找过的位置和下一步该做什么。" },
  { title: "各处用同一个 Codex", text: "终端、派出的 worker 和原生模式运行的是同一个 Codex。恢复的终端会先等第一次 Codex 检查完成（最多 3 秒），再启动。" },
];
