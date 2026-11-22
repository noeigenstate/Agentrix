// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "角色回退", text: "在 Windows 上还没完成 Codex 沙箱设置时，分给 Codex 的角色不再报错：Claude 做总指挥时改用总指挥的 Claude 模型运行并注明，Codex 做总指挥时提示它使用自带的子代理。" },
];
