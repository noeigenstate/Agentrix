// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "团队式模型路由", text: "组织图中，你是所有者，下设总指挥，再往下是产品、架构师、设计师、开发、审查、测试、研究、运维和安全九个角色，每个角色都可单独设置模型、思考深度和快速模式。原有的座位设置会自动迁移。", group: "new" },
  { title: "取消 /model", text: "新开和恢复的对话都由模型路由决定模型、思考深度和快速模式。/model、/effort 和 /fast 已停用，在对话输入框输入这些命令会提示你并打开模型路由。", group: "new" },
  { title: "技能跟随路由", text: "系统的模型路由技能会随你的设置自动更新，从下一次对话起生效。技能可设为「每个任务」或「相关任务」触发，也可开启「首次打开项目时先运行一次」。", group: "new" },
  { title: "活动区路由卡", text: "活动区的卡片显示当前模型路由概况，点击即可打开模型路由。主模型的任务超过四条时会折叠显示。", group: "new" },
  { title: "Agent 按角色", text: "左侧 Agent 标签页按角色分组显示子 Agent，列出名称、模型、任务、状态和用时。点开一条即可查看简报和日志。", group: "new" },
  { title: "模型路由改版", text: "圆桌现在占满整个弹窗，文字更大；模型放在右侧面板里，按系列和线路分组、最新的在前、旧版本折叠起来，还能搜索。中间显示 规划 → 构建 → 审查 → 验收，以及每一步用到哪些座位。" },
  { title: "强度直接调", text: "每个座位的思考深度和快速开关，现在直接在座位上点就能改；以前只能在「更换」里改，有些座位上的控件还点不了。" },
  { title: "菜单能关掉", text: "「更换」和强度弹窗，点外面、再点一次、点 ✕ 或按 Esc 都能关掉。" },
  { title: "模型路由座位", text: "右侧活动栏的「模型路由」按钮会打开一张 3D 圆桌，固定座位有领队、架构师、核心工程师、执行工程师、视觉与验收、查找、审查。把模型拖到座位上，或点「更换」；每个座位可设思考深度和快速模式，可选全局或本项目，从下一次对话起生效；审查者与作者是同一个模型时，只要有别的模型可用就会被拦下。" },
  { title: "模型列表跟随新版本", text: "座位选择器会读取当前 Codex 和 Claude 的模型列表，新模型（例如 GPT-6.2-Sol）会自己出现，并带着各自的思考深度档位和快速选项。默认值会移到同一系列里最新的模型；你已保存的座位不会被改动，也可以直接输入别的模型 ID。" },
  { title: "后台任务默认关闭", text: "Agentrix 启动的 Claude Code 会话（终端、原生模式、worker、SSH 和实验室）默认不带后台任务，并行的工作通过看得见的子代理进行。在设置里打开「允许 Claude Code 后台任务」，之后新启动的会话就会重新允许。" },
  { title: "worker 分离启动", text: "调度器现在把 worker 分离启动，主控负责等待它们，所以耗时长的 worker 不会被中途切断，也可以几个并排运行；主控的这一轮会一直显示「工作中」，直到它的 worker 全部结束。" },
  { title: "确认弹窗更可靠", text: "阅读视图的终端弹窗，即使项目当时不在屏幕上，每个提示也只会打开一次；你主动关闭后，这个提示不会再弹出。提示期间暂存的消息会在提示结束后发送一次（你在看别的项目时也一样）；迟到的权限信号不再让你回答之后还亮着等待灯。" },
  { title: "终端 worker", text: "在终端主控下，调度器启动的 Claude worker 现在是后台隐藏的交互式 Claude Code 会话，计费与你的终端一致。它的行显示速率，需要确认时显示「等待你确认」；点这一行，就能在分屏里它自己的终端中回答。无法这样启动时，会退回之前的非交互调用。" },
  { title: "语音输入不再直接发送", text: "听写后按回车（或再按一次 Ctrl+T），文字只会放进输入框，不会发送；要发送请自己按回车。在没有输入框的终端里，文字会被粘贴，不会按任何键。" },
  { title: "✓ 完成更稳", text: "Claude 工作时你排队的消息，包括以 / 或 # 开头的，不再让上一轮的「✓ 完成」提前出现；Claude Code 的本地命令（如 /theme）也不会再拖住它。" },
  { title: "worker 不入历史", text: "重启后，worker 的对话不再出现在项目的 Claude 历史里，所以在你自己的终端里「继续」不能恢复 worker 的对话。" },
  { title: "Windows 关闭更净", text: "在 Windows 上关闭原生模式的 Codex 会话，会结束它启动的所有进程，退出 Agentrix 时也会等这件事完成。" },
  { title: "强制调度", text: "Claude Code 或 Codex 在会话里用自己的命令行工具再启动 Codex 或 Claude 时，现在会经过调度器，显示为带「自启动」标记和速率的 worker 行，不再暗中运行。这样的调用默认只读，除非它要求写入权限；你自己在终端或用 ! 输入的命令照旧运行真正的命令行。" },
  { title: "Claude 子代理行", text: "Claude Code 用 Agent 工具启动的子代理，在终端和原生模式里都会从启动那一刻起显示为一行。继续的子代理标「继续」；按 Esc 或停止的记为已停止，不再算成功；后台子代理按 Esc 也不会被打断。" },
  { title: "Claude 路径统一", text: "连接测试和下一个新会话现在总是走同一条路径、用同一种计费。修好 Claude Code 的设置文件后，下一个新会话就生效，不必重启 Agentrix；「余额不足」的结果对所有项目里的 API key 都适用；Claude Code 缺失或版本太旧时，新会话会说明情况和原因。" },
  { title: "终端状态更稳", text: "迟到或重复的事件不会再让 Claude 终端的状态倒退。有消息排队时，Claude 的「Press up to edit queued messages」占位提示不再被当成你输入的文字。" },
  { title: "虚拟实验室调度", text: "调度助手在 Windows 和 macOS 的虚拟实验室里又能正常加载了。" },
];
