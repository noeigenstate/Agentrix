// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "测试连接", text: "检查计费来源时，API 预算用完、设为 0 或被其他会话占用，不再报错退出。" },
  { title: "预算用完先说明", text: "API 预算用完、设为 0 或被正在运行的会话占用时，新会话启动前会写明是哪一种，并按设置转到终端，不再让 Claude Code 崩溃。" },
  { title: "预算不再卡住", text: "应用崩溃或被强制关闭后，上次占住的预算不会一直卡到月底。" },
  { title: "余额不足提示", text: "控制台余额不足时，会提示「控制台余额不足，请到 Claude Console 的 Billing 充值」，并按设置转到终端。" },
  { title: "英文界面", text: "使用英文界面时，预算、余额不足和计费来源的原因也显示为英文。" },
];
