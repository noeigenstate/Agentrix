// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
export const WHATS_NEW: { title: string; text: string }[] = [
  { title: "打开项目", text: "会话先显示最近的对话，往上翻再加载更早的内容，很长的对话也能在约 1 秒内看到。" },
  { title: "目录外预览", text: "回复里提到项目目录外的 HTML 页面或视频，也能直接预览；预览中的页面不能联网。" },
  { title: "消息图片", text: "Codex 消息里附带的图片会显示在你发的那条消息里，只显示一次；图片缺失或过大时显示占位。" },
  { title: "未能启动", text: "没能启动的子任务条目 5 秒后自动收起，其他失败的条目仍保留到你查看。" },
  { title: "启动提示", text: "助手启动期间输入框里的「正在启动…」对比度提高，浅色和深色主题下都看得清。" },
];
