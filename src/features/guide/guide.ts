// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new" }[] = [
  { title: "测试连接", text: "连接测试不再把 Claude Code 误报为「未找到」，检查失败时会写明原因；密钥被拒时显示 Anthropic 返回的原文，只是不能列出模型的密钥仍可正常使用。" },
  { title: "Codex 额度", text: "Claude 在终端模式下派发的 Codex 工作者，活动栏也会显示 Codex 的连接和额度，不同账号的额度不会混在一起。" },
  { title: "SSH 上的 Codex", text: "SSH 项目里的 Codex 原生会话在 Python 3.6 的主机和用 nvm 安装 Codex 的主机上也能启动；启动失败时提示会附上具体原因。" },
  { title: "生成的图片", text: "Codex 生成的图片在 SSH 项目里也会显示，并自动复制到项目的 generated-images 文件夹；恢复会话时，较早的图片点一下再加载。" },
  { title: "图片链接", text: "点击回复里的文件链接，会在左侧文件树中定位并高亮；Ctrl+点击图片链接直接预览。" },
  { title: "复制路径", text: "在回复里的文件链接上点右键，可以复制它的完整路径；生成的图片复制的是项目里那份的路径。" },
  { title: "跟随系统", text: "新安装首次启动时跟随系统的浅色或深色外观，已有设置不变。" },
  { title: "AppImage 更新", text: "Linux 的 AppImage 文件名不再带 linux，并且从 1.4.1 起可以用 AppImageUpdate 等工具更新。" },
  { title: "SSH 连接", text: "修复 1.4.0 打开 SSH 项目时提示 Invalid dispatch modules、会话无法启动的问题。" },
];
