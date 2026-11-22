// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "指挥家模式", text: "打开模型路由里的「指挥家模式」后，总指挥只负责规划，用角色工具在后台同时调用多个团队角色，角色一结束就通知它；关闭时总指挥像原来的命令行一样自己完成任务。切换模式或更换总指挥的模型、思考深度和快速模式，正在运行的对话从下一条消息起生效，终端里的 Claude 对话也能调用角色。" },
  { title: "团队路由", text: "模型路由把团队排成总指挥和九个角色，每个角色可单独设置模型、思考深度和快速模式，保存后立即生效。还可从角色库加入前端、后端等八个角色，或复制现有角色自定名称和职责，团队最多启用 16 个角色。" },
  { title: "项目路由", text: "每个项目的团队设置保存在项目文件夹的 .agentrix/routing.json 中，可随仓库共享；没有这个文件的项目打开时会按「我的默认模板」自动创建一份。克隆、git pull 或编辑器带来的改动会先请你确认，并标出有风险的变化。" },
  { title: "角色一览", text: "左侧 Agent 标签页按角色列出总指挥调用的角色和 Claude Code 启动的子代理，显示模型、任务、状态和真实用时；点一条即可打开它的工作会话，主模型和它收到的提示显示在「总指挥」下。" },
  { title: "角色沙箱", text: "在 Windows 上，Codex 角色在提权沙箱里运行，可以直接跑测试。Agentrix 启动后会提示一次性设置：需要管理员批准，并会修改你的 Codex 配置，让所有 Codex 会话默认使用这一沙箱；也可以选「以后再说」或「不再提示」。" },
  { title: "阅读视图", text: "回复中的行内公式和独立公式按数学格式显示，不支持的公式显示原文。发送也更可靠：输入行的灰色提示和建议不再被当成草稿，粘贴失败会自动重试，已发出的消息不会重复发送，每个确认提示只弹出一次。" },
  { title: "模型选择", text: "模型列表跟随 Codex 和 Claude 的新版本自动更新，旧版本按系列折叠，可以搜索，也能直接输入模型 ID。对话的模型、思考深度和快速模式都由模型路由决定，输入 /model、/effort 或 /fast 会提示你并打开模型路由。" },
  { title: "运行更稳", text: "迟到或重复的事件不再让 Claude 终端的状态倒退，排队的消息也不再让「✓ 完成」提前出现。Agentrix 启动的 Claude Code 默认不使用后台任务，需要时可在设置里打开；连接测试和新会话总是用同一种方式和计费启动 Claude。" },
];
