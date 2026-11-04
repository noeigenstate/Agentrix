// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// group: "new" marks what this beta adds. Those notes come first; the list shows them under their own heading and the rest under "also in".
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "用量卡", text: "活动栏里 Claude 和 Codex 分开显示连接方式、新会话走哪条路和额度，保存密钥或改运行方式后马上更新。", group: 'new' },
  { title: "计费检查", text: "测试连接会确认 Claude Code 报告的计费来源是 API 密钥；不是的话，新会话转到终端并说明原因，不再直接失败。", group: 'new' },
  { title: "原生通道修复", text: "修好了 Codex 的原生连接和 Claude 走 API 时的启动失败。", group: 'new' },
  { title: "原生界面", text: "Claude 通过 API、Codex 通过 app-server 在应用自己的界面里运行，命令、改动、计划和确认都直接显示；也可以在设置里改回终端界面。" },
  { title: "运行方式", text: "设置里可以保存 API 密钥、测试连接、设定月预算；Claude 默认走 API，额度用完自动转到订阅登录的终端，接着同一段对话。" },
  { title: "连接与额度", text: "活动栏显示 Claude、Codex 当前连接的是 API 还是订阅，以及 API 今日和本月的估算花费、预算和限流状态。" },
  { title: "插话直达", text: "给子代理的话直接送到它那里（Claude 中途接收，Codex 在当前一步后接收），不再转给主会话，分屏里显示送达状态。" },
  { title: "实时状态", text: "终端里的状态实时同步到阅读视图和活动栏，处理完立即可以继续；遇到终端里的确认时，你打的消息先排队，处理完再发出。" },
  { title: "更新通道", text: "设置的「关于」页可以选择稳定版或测试版；切到测试版前需同意测试协议，随时可以切回稳定版，不会被降级。" },
  { title: "确认在终端", text: "终端界面里需要你确认或选择时，以及输入任何斜杠命令时，都会直接弹出终端；你正在输入时弹出的终端不会抢走焦点。" },
  { title: "数据看板", text: "改用彩色图表，各模型的用时、费用和通过率一眼可比，数据每分钟自动更新。" },
  { title: "子代理分屏", text: "在活动栏点一个子代理，对话旁会显示它正在做什么，一次只显示一个，点另一个就替换；派发的工作者可以直接在这里收到你的提示。" },
  { title: "引用消息", text: "阅读视图里可以引用一条消息，带着它继续对话。" },
  { title: "系统技能", text: "始终以系统自带的为准：项目里同名的副本会被自动移到恢复文件夹；想扩展，请把技能命名为「系统技能名-标识」。" },
  { title: "技能即时更新", text: "技能改动后，正在运行的 Claude Code 会话在下一次压缩或清空对话时就会拿到新版本。" },
  { title: "虚拟实验室", text: "本项目历史、知名开源项目和 AA 测试三种任务来源可以多选，各自独立运行再汇总比较；实验里的模型连不到本机的 Docker，也改不了评分环境。" },
  { title: "处理中也能输入", text: "Claude Code 或 Codex 工作时也能继续输入和发送，消息排在当前步骤之后；停止按钮和 Esc 随时可用。" },
  { title: "浅色终端", text: "白色主题下，为深色终端设计的文字会自动换成深色，正文和次要文字都清楚可读。" },
  { title: "模型路由", text: "后端设计和调试主要交给 GPT-6.1-Sol，Sol 默认改为 high + fast。" },
];
