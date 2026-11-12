// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "Codex 权限", text: "设置的「运行方式」页可以选「全部放开（默认）」「按 Codex 配置」或「先询问」，新的原生 Codex 会话按所选方式启动；在会话里输入 /permissions 可切换当前会话，从下一轮起生效。派发出去的工作者不受影响。从 1.4.1 升级后，原生 Codex 会话默认「全部放开」（不询问、不使用沙箱）；想保持原来的行为，请在设置里选「按 Codex 配置」。" },
  { title: "工作时也能发送", text: "Claude Code 在终端模式下工作时也能发消息，和在终端里一样由它自己排队。" },
  { title: "终端里的未发文字", text: "终端输入框里还有没提交的文字时，可以选「先发送终端里这段」或「清空它，再发送新消息」，不再出现误报的提示；待发区和提示块也换了新版式。" },
  { title: "发送框不再闪烁", text: "Claude 工作时，发送框的提示文字、中断按钮、状态行和结果卡不再来回闪动；一轮结束后，中断按钮不会再误发 Esc。" },
  { title: "子代理显示", text: "SSH 项目里的子代理也会显示真实的模型名和 token 速率；一组子代理里有的读不到记录时，按读到的部分显示速率。" },
  { title: "派发更及时", text: "派发出去的 Codex 工作者报告额度后，活动栏会立刻刷新；查找团队目录不再卡住界面；派发的消息送不到 Agentrix 时，规划员的终端里会写明原因。" },
  { title: "查找安装位置", text: "用 npm、WinGet、旧版本地安装或系统 PATH 装的 Claude Code 都能找到；找不到时会写明查过哪些地方。npm 安装跳过了安装步骤、缺了原生程序时，会提示用官方安装器重装。终端和原生模式默认用同一个 Claude Code，版本不一致时会提醒。" },
  { title: "写明失败原因", text: "测试连接无法确认计费来源时会写明原因，例如找不到 Claude Code、安装不完整、版本过低、没有保存密钥、初始化超时，或 Claude Code 启动后退出；原生会话启动失败时也会写明原因。" },
  { title: "只用保存的密钥", text: "原生模式只用 Agentrix 里保存的 API 密钥，Claude Code 设置里的 apiKeyHelper 不会再让 API 通道无法使用；终端里的 Claude Code 不受影响。" },
];
