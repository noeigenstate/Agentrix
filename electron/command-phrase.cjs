const COMMAND_PHRASES = [
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:vitest|jest|pytest|mocha)\b|\b(?:cargo|go|dotnet)\s+test\b|\bnode\s+--test\b|\bnpm\s+run\s+test:/i, '运行测试'],
  [/\b(?:npm|pnpm|yarn|bun)\s+run\s+(?:build|dist|pack)\b|\b(?:vite|webpack|cargo|dotnet|go)\s+build\b|\bmsbuild\b|\belectron-builder\b/i, '构建项目'],
  [/\b(?:eslint|prettier|ruff|flake8|stylelint)\b|\bcargo\s+clippy\b|\b(?:npm|pnpm|yarn)\s+run\s+(?:lint|format)\b/i, '检查代码格式'],
  [/\btsc\b|\b(?:npm|pnpm|yarn)\s+run\s+(?:typecheck|check)\b|\bmypy\b/i, '检查类型'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|i)\b|\bpip3?\s+install\b|\bcargo\s+add\b/i, '安装依赖'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|serve|preview)\b/i, '启动项目'],
  [/\bgit\s+status\b/i, '查看 Git 状态'],
  [/\bgit\s+(?:diff|show)\b/i, '查看改动'],
  [/\bgit\s+log\b/i, '查看提交历史'],
  [/\bgit\s+commit\b/i, '提交改动'],
  [/\bgit\s+(?:add|restore|reset|rm)\b/i, '整理暂存区'],
  [/\bgit\s+push\b/i, '推送到远程仓库'],
  [/\bgit\s+(?:pull|fetch|clone)\b/i, '拉取代码'],
  [/\bgit\s+(?:checkout|switch|branch|merge|rebase|stash|tag|cherry-pick)\b/i, '处理分支'],
  [/\bgit\s+grep\b/i, '搜索代码'],
  [/\bgit\b/i, '执行 Git 命令'],
  [/\bgh\s+\w/i, '操作 GitHub'],
  [/\b(?:rg|grep|findstr|Select-String|ag)\b/i, '搜索代码'],
  [/\b(?:cat|Get-Content|head|tail|nl)\b|\bsed\s+-n\b/i, '读取文件'],
  [/\b(?:ls|dir|Get-ChildItem|gci|tree|fd)\b|\bfind\s+[.\/~]/i, '查看目录'],
  [/\b(?:rm|del|Remove-Item|rmdir)\b/i, '删除文件'],
  [/\b(?:mkdir|New-Item)\b/i, '新建文件或目录'],
  [/\b(?:cp|mv|Copy-Item|Move-Item|Rename-Item)\b/i, '移动或复制文件'],
  [/\b(?:curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod)\b/i, '访问网络'],
  [/\b(?:Start-Sleep|sleep)\b/i, '等待'],
];
const SCRIPT = /\b(?:node|python3?|py|deno|bun|tsx|ts-node)\s+(?:-\S+\s+)*["']?([^\s"';&|]+)/i;
// { phrase, object }: the phrase is one of COMMAND_PHRASES (or 运行脚本 / 运行命令), the object a script or program name.
function commandPhrase(command) {
  const text = String(command || '');
  for (const [pattern, phrase] of COMMAND_PHRASES) if (pattern.test(text)) return { phrase, object: '' };
  const script = SCRIPT.exec(text);
  if (script) return { phrase: '运行脚本', object: script[1].split(/[\\/]/).pop() };
  const program = /^\s*(?:&\s*)?["']?([^\s"']+)/.exec(text);
  return { phrase: '运行命令', object: program ? program[1].split(/[\\/]/).pop() : '' };
}
const PHRASES = [...COMMAND_PHRASES.map(([, phrase]) => phrase), '运行脚本', '运行命令'];

module.exports = { commandPhrase, PHRASES };
