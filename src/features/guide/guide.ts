// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new"; highlight?: true }[] = [
  { title: "同一环境", text: "Codex 角色改用你本人的账号运行，权限和总指挥一样，可以联网，Unity 这类要读许可证的软件也能正常用了。", highlight: true },
  { title: "规则把关", text: "角色每次跑命令或改文件都按同一份规则检查：不能提交、推送或强制回退，也不能清掉别人还没提交的改动。" },
  { title: "事后核对", text: "角色结束后，如果分支、标签或远端记录有变化，结果里会写明前后的不同。" },
  { title: "未送达", text: "Claude Code 重启时丢掉的排队消息会标成“未送达”，可以重新发送或丢弃，不会一直显示“已排队”。" },
  { title: "提议留存", text: "角色对技能提出的修改建议会长期保存，并直接写进角色结果，不会再随临时文件一起被清理。" },
  { title: "旧沙箱", text: "以前装过 Codex 的 Windows 沙箱，可以在管理员终端运行 codex sandbox uninstall 清理；不清理也不影响使用。" },
];
