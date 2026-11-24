import { useEffect, useState } from 'react';
import type { AgentsState, ClaudeFound, CodexAgentState, Reason } from '../../shared/types';
import { t } from '../../shared/i18n';
import { isWindows } from '../../shared/platform';
import { installerCommand, viaWords } from '../native-session/native-words';
import { nativeBridge } from '../native-session/native-bridge.ts';
import { codexWords } from '../../shared/reason-words/codex.ts';
import { adapters } from '../../../electron/features/cli-adapters/registry.mjs';

const api = window.agentrix;
const settingsAdapters = [...adapters()].reverse();
// What an installed agent reads as: Claude Code says which install the terminal runs, a split (the native path runs another),
// an install that cannot run (too old, a failed check, npm's package without its native program) and the step to take. The
// connection test is only reachable with an API key saved, so without one the step is the installer's command or saving the key.
const found = ({ version, via }: Partial<ClaudeFound>) => [version ? t('版本 {version}', { version }) : t('版本未知'), via && t('来自 {via}', { via: viaWords(via) })].filter(Boolean).join(' · ');
const from = (via: ClaudeFound['via'] | undefined) => via && t('来自 {via}', { via: viaWords(via) });
// How Codex was found, one whole phrase per codex-runtime VIAS entry (tests/codex-runtime-guards.test.cjs keeps them equal).
// Whole phrases, not a shared "来自 {via}", so English can read "from the official installer" in the middle of a sentence.
const CODEX_VIA_WORDS: Record<string, string> = {
  path: '来自 PATH', 'npm-shim': '来自 npm 或 pnpm 命令', 'npm-vendor': '来自 npm 全局安装', 'npm-hoisted': '来自 npm 平台包', 'npm-prefix': '来自 npm 全局目录',
  'registry-path': '来自系统 PATH（注册表）', 'official-installer': '来自官方安装器', winget: '来自 WinGet', system: '来自系统目录',
  scoop: '来自 Scoop', chocolatey: '来自 Chocolatey', volta: '来自 Volta', bun: '来自 Bun', pnpm: '来自 pnpm', yarn: '来自 Yarn', nvm: '来自 nvm-windows', fnm: '来自 fnm',
  'vscode-extension': '来自 VS Code 扩展', registry: '来自已安装的程序（注册表）', 'drive-scan': '来自本地磁盘搜索',
};
// A Codex reason in words: its code's phrase with its params filled in.
const reasonWords = ({ code, params = {} }: Reason) => (codexWords[code]
  ? t(codexWords[code], Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]))) : code);
// A check that printed no version says why, and the detail main saw (an exit code) when it has one.
const versionHint = (reason: Reason) => (reason.detail ? t('{reason}（{detail}）', { reason: reasonWords(reason), detail: reason.detail }) : reasonWords(reason));
// Codex says its version and how it was found; a check that printed no version says why. Before the first search main
// gives only whether it is installed.
function codexInstalledWords({ version, via, reason }: CodexAgentState): { text: string; hint: string | null } {
  if (via === undefined) return { text: t('已安装'), hint: null };
  const words = CODEX_VIA_WORDS[via];
  return { text: [t('已安装'), version ? t('版本 {version}', { version }) : t('版本未知'), words && t(words)].filter(Boolean).join(' · '),
    hint: reason ? versionHint(reason) : null };
}
// The places a not-found reason lists, one per entry (main joins them with "; "; a place starts with ~, a drive or a root).
const placesOf = (reason: Reason) => (typeof reason.params?.searched === 'string' ? reason.params.searched.split(/; (?=~|[A-Za-z]:|[\\/])/).filter(Boolean) : []);
// A path that may wrap after each \ or /; a segment longer than the line breaks by the style's overflow-wrap.
function PathText({ text }: { text: string }) {
  const parts = text.split(/(?<=[\\/])/);
  return <>{parts.flatMap((part, index) => (index < parts.length - 1 ? [part, <wbr key={index} />] : [part]))}</>;
}
function installedWords(agent: 'codex' | 'claude', state: AgentsState, keySaved: boolean | null): { text: string; hint: string | null } {
  const claude = state.claude, noKey = keySaved === false, testHint = t('到「运行方式 › 测试连接」查看原因。');
  if (agent === 'codex') return codexInstalledWords(state.codex);
  if (claude.incomplete) return { text: t('安装不完整'), hint: noKey ? t('npm 装了，但里面没有原生程序。请用官方安装器重新安装：{command}', { command: installerCommand(isWindows) }) : t('npm 装了，但里面没有原生程序。{hint}', { hint: testHint }) };
  if (claude.reason === 'too_old') return { text: [claude.version ? t('版本 {version} 过低', { version: claude.version }) : t('版本过低'), from(claude.via)].filter(Boolean).join(' · '), hint: t('请升级 Claude Code。') };
  if (claude.reason) return { text: t('已安装 · 检查未通过'), hint: noKey ? t('检查没有通过。先在「运行方式」里保存 API 密钥，再点「测试连接」查看原因。') : testHint };
  if (claude.notice === 'cli_split_versions' && claude.native) return { text: [t('已安装'), claude.version ? t('终端用版本 {version}', { version: claude.version }) : t('终端用的版本未知'), from(claude.via)].filter(Boolean).join(' · '), hint: t('原生用的是另一份：{found}', { found: found(claude.native) }) };
  return { text: [t('已安装'), claude.version && t('版本 {version}', { version: claude.version }), from(claude.via)].filter(Boolean).join(' · '), hint: null };
}
// visible: whether the page is the one shown (it stays mounted), so the saved key is read again each time it is.
export function AgentsSettings({ agents, onChange, visible = true }: { agents: AgentsState | null; onChange: (state: AgentsState) => void; visible?: boolean }) {
  const [pending, setPending] = useState(false);
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void nativeBridge()?.keyStatus().then(status => { if (active && status.ok) setKeySaved(status.value.saved); }).catch(() => {});
    return () => { active = false; };
  }, [visible]);
  const [error, setError] = useState('');
  const install = async (agent: 'codex' | 'claude') => {
    setPending(true); setError('');
    try { const result = await api.installAgent(agent); if (result.ok) onChange(result.value); else setError(result.error); }
    catch (err) { setError(String(err)); }
    finally { setPending(false); }
  };
  const openNode = async () => { try { const result = await api.openNode(); if (!result.ok) setError(result.error); } catch (err) { setError(String(err)); } };
  return <>
    <p className="agents-intro">{t('Agentrix 基于 Codex 和 Claude Code 这两个命令行工具：在每个项目的终端里运行它们，这里负责并排显示、提醒完成和恢复会话。至少安装其中一个。')}</p>
    {settingsAdapters.map(({ manifest: { id: agent, install: { label, npm } } }) => {
      // Codex not found says where it looked and what to do next, once the scan of the local drives is over; one found
      // says which file it runs.
      const codex = agent === 'codex' ? agents?.codex : null, scanning = !codex?.installed && codex?.scan === 'running';
      const notFound = codex && !codex.installed && codex.reason && !scanning ? codex.reason : null, missing = notFound?.code === 'codex.not_found';
      const words = agents?.[agent].installed ? installedWords(agent, agents, keySaved) : null, hint = words ? words.hint : notFound ? reasonWords(notFound) : null;
      const places = missing ? placesOf(notFound) : [], step = !missing ? null
        : codex?.scan === 'done' ? t('也搜索了所有本地磁盘。用下面的命令安装，装好后 Agentrix 会自己发现。')
          : codex?.scan === 'partial' ? t('已搜索部分本地磁盘，下次启动会再搜索一次。用下面的命令安装，装好后 Agentrix 会自己发现。') : t('用下面的命令安装，装好后 Agentrix 会自己发现。');
      const file = codex?.installed ? codex.fileShown : null, settled = !!agents && agents.installing !== agent;
      const installation = agents?.[agent];
      const command = installation && 'incomplete' in installation && installation.incomplete ? installerCommand(isWindows) : `npm install -g ${npm}`;
      return <div className="agent-setting" key={agent}>
      <div className="setting-row"><span className="agent-info"><b>{label}</b>
        <small role="status" className="agent-status" title={installation?.fileShown}>
          {!agents ? t('正在检测…') : agents.installing === agent ? t('正在安装…') : words ? words.text : scanning ? t('正在搜索所有本地磁盘…') : t('未安装')}
        </small>
        {settled && file && <small className="agent-path"><PathText text={file} /></small>}
        {settled && hint && <small className="agent-hint">{hint}</small>}
        {settled && places.map(place => <small className="agent-path" key={place}><PathText text={place} /></small>)}
        {settled && step && <small className="agent-hint">{step}</small>}</span>
        {agents && !agents[agent].installed && <button type="button" className="button secondary small" disabled={pending || !!agents.installing || !agents.npm} onClick={() => void install(agent)}>{t('一键安装')}</button>}</div>
      <code className="agent-command">{command}</code>
    </div>; })}
    {agents && !agents.npm && <div className="agents-node"><span>{t('需要先安装 Node.js')}</span><button type="button" className="button secondary small" onClick={() => void openNode()}>{t('下载 Node.js')}</button></div>}
    {(error || agents?.error) && <p className="form-error agents-error" role="alert">{error || agents?.error}</p>}
    {agents?.message && <p className="agents-message" role="status">{agents.message}</p>}
  </>;
}
