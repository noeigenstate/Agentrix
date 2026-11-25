// What the usage guide and the About page list for this release; the guide opens on it after an update.
// Each note is a short title and one detail line, both with their English at the end of electron/locales/en.json.
// A beta may mark its additions with group: "new"; the list then shows them under their own heading and the rest under "earlier betas".
// The first beta of a version has nothing earlier to set apart, so it carries no group and shows one list; a stable release carries none either.
export const WHATS_NEW: { title: string; text: string; group?: "new"; highlight?: true }[] = [
  { title: "请更新", text: "请把 Claude Code 更新到最新版本。版本太旧时，开发角色可能停在一个看不见的确认框上，一直等着。", highlight: true },
  { title: "大白话", text: "新增一个系统技能，所有项目的会话和角色都用日常的话回复，先说结论和需要你做的事，再说细节。" },
  { title: "切换提示", text: "会话正忙时改了模型或思考深度，会显示“这一轮结束后切换到 …”，切换完成后这句话消失。" },
  { title: "数据保护", text: "设置、项目列表、密钥这类文件一时读不出来（比如被杀毒软件锁住）时会重试；文件真的损坏时先备份再提醒，不会用空数据覆盖。" },
  { title: "失败说明", text: "终端里启动 claude 或 codex 失败时，会说清楚是哪一步出了问题、该怎么办，不再什么都不说就返回。" },
  { title: "记忆容错", text: "团队记忆里有一行坏数据时只跳过那一行，角色的任务说明照常生成。" },
  { title: "稳定性", text: "修复了一百多处可能出错的地方，包括复制粘贴、输入法回车、慢电脑上的事件提醒和远端连接。" },
];
