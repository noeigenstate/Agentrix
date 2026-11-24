// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "快速提示", text: "Claude Code 拒绝过快速模式后，在模型路由里点总指挥的“快速”开关会当场提示原因，不用等保存后再看终端；再点一次仍可打开重试。", group: "new" },
  { title: "审查测试", text: "只读的 Claude 角色（例如审查）现在可以运行命令和测试，是否运行、运行哪些由角色按任务决定；仍不能改文件、提交或推送。", group: "new" },
  { title: "Ultracode", text: "模型路由里总指挥座位多了 Ultracode 开关：打开后每个任务都用多代理工作流，新对话直接带上，运行中的对话自动切换，左栏和路由卡会显示。" },
  { title: "快速切换", text: "指挥家模式下，路由里的快速模式会自动切到运行中的 Claude Code，且不改你保存的默认；被拒绝时会弹出命令行给的原因，例如需要 usage credits。" },
  { title: "重复切换", text: "把总指挥改回这段对话里用过的模型或思考深度时，会再次自动切换，左栏不再停在旧值上。" },
  { title: "深度切换", text: "指挥家模式下把总指挥的思考深度改成 max 时，运行中的 Claude Code 现在会正确切换，不再被取消。" },
];
