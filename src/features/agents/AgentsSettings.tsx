import { useEffect, useState } from 'react';
import type { AgentProvider } from '../../shared/agent-events';
import type { AgentsState, ClaudeAgentState, ClaudeFound, CodexAgentState, Reason } from '../../shared/types';
import { t } from '../../shared/i18n';
import { isWindows } from '../../shared/platform';
import { installerCommand, viaWords } from '../native-session/native-words';
import { nativeBridge } from '../native-session/native-bridge.ts';
import { CODEX_VIA_WORDS } from './codex-via-words.ts';
import { codexWords } from '../../shared/reason-words/codex.ts';
import { adapters } from '../../../electron/features/cli-adapters/registry.mjs';
import { belowMinimum } from '../../../electron/features/cli-adapters/capabilities.mjs';

const api = window.agentrix;
const settingsAdapters = [...adapters()].reverse();
type InstallWords = { text: string; hint: string | null };
// What an installed agent reads as: Claude Code says which install the terminal runs, a split (the native path runs another),
// an install that cannot run (too old, a failed check, npm's package without its native program) and the step to take. The
// connection test is only reachable with an API key saved, so without one the step is the installer's command or saving the key.
const found = ({ version, via }: Partial<ClaudeFound>) => [version ? t('版本 {version}', { version }) : t('版本未知'), via && t('来自 {via}', { via: viaWords(via) })].filter(Boolean).join(' · ');
const from = (via: ClaudeFound['via'] | undefined) => via && t('来自 {via}', { via: viaWords(via) });
// How Codex was found, one whole phrase per codex-runtime VIAS entry (tests/codex-runtime-guards.test.cjs keeps them equal).
// Whole phrases, not a shared "来自 {via}", so English can read "from the official installer" in the middle of a sentence.
// A Codex reason in words: its code's phrase with its params filled in.
const reasonWords = ({ code, params = {} }: Reason) => (codexWords[code]
  ? t(codexWords[code], Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]))) : code);
// A check that printed no version says why, and the detail main saw (an exit code) when it has one.
const versionHint = (reason: Reason) => (reason.detail ? t('{reason}（{detail}）', { reason: reasonWords(reason), detail: reason.detail }) : reasonWords(reason));
// Codex says its version and how it was found; a check that printed no version says why. Before the first search main
// gives only whether it is installed.
function codexInstalledWords({ version, via, reason }: CodexAgentState): InstallWords {
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
function claudeInstalledWords(claude: ClaudeAgentState, keySaved: boolean | null): InstallWords {
  const noKey = keySaved === false, testHint = t('到「运行方式 › 测试连接」查看原因。');
  if (claude.incomplete) return { text: t('安装不完整'), hint: noKey ? t('npm 装了，但里面没有原生程序。请用官方安装器重新安装：{command}', { command: installerCommand(isWindows) }) : t('npm 装了，但里面没有原生程序。{hint}', { hint: testHint }) };
  if (claude.reason === 'too_old') return { text: [claude.version ? t('版本 {version} 过低', { version: claude.version }) : t('版本过低'), from(claude.via)].filter(Boolean).join(' · '), hint: t('请升级 Claude Code。') };
  if (claude.reason) return { text: t('已安装 · 检查未通过'), hint: noKey ? t('检查没有通过。先在「运行方式」里保存 API 密钥，再点「测试连接」查看原因。') : testHint };
  if (claude.notice === 'cli_split_versions' && claude.native) return { text: [t('已安装'), claude.version ? t('终端用版本 {version}', { version: claude.version }) : t('终端用的版本未知'), from(claude.via)].filter(Boolean).join(' · '), hint: t('原生用的是另一份：{found}', { found: found(claude.native) }) };
  return { text: [t('已安装'), claude.version && t('版本 {version}', { version: claude.version }), from(claude.via)].filter(Boolean).join(' · '), hint: null };
}
// visible: whether the page is the one shown (it stays mounted), so the saved key is read again each time it is.
export function AgentsSettings({ agents, onChange, visible = true }: { agents: AgentsState | null; onChange: (state: AgentsState) => void; visible?: boolean }) {
  const installations: Partial<Record<AgentProvider, Pick<CodexAgentState, 'installed' | 'fileShown' | 'version'>>> | null = agents;
  const [pending, setPending] = useState(false);
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void nativeBridge()?.keyStatus().then(status => { if (active && status.ok) setKeySaved(status.value.saved); }).catch(() => {});
    return () => { active = false; };
  }, [visible]);
  const [error, setError] = useState('');
  const install = async (agent: AgentProvider) => {
    setPending(true); setError('');
    try { const result = await api.installAgent(agent); if (result.ok) onChange(result.value); else setError(result.error); }
    catch (err) { setError(String(err)); }
    finally { setPending(false); }
  };
  const openNode = async () => { try { const result = await api.openNode(); if (!result.ok) setError(result.error); } catch (err) { setError(String(err)); } };
  return <>
    <p className="agents-intro">{t('安装与 Agentrix 搭配使用的命令行工具。')}</p>
    {settingsAdapters.map(({ manifest: { id: agent, install: { label, npm, diagnostics, page, commands, minVersion } } }) => {
      const installation = installations?.[agent];
      const manual = !npm && commands?.[isWindows ? 'windows' : 'unix'];
      const showInstructions = manual && agents && !installation?.installed;
      // Codex not found says where it looked and what to do next, once the scan of the local drives is over; one found
      // says which file it runs.
      const search = diagnostics === 'drive-scan' ? installation as CodexAgentState | undefined : undefined;
      const scanning = !search?.installed && search?.scan === 'running';
      const notFound = search && !search.installed && search.reason && !scanning ? search.reason : null, missing = notFound?.code === 'codex.not_found';
      const split = diagnostics === 'split-install' ? installation as ClaudeAgentState | undefined : undefined;
      const words = search?.installed ? codexInstalledWords(search) : split?.installed ? claudeInstalledWords(split, keySaved) : null;
      const outdated = manual && installation?.version && belowMinimum(installation.version, minVersion);
      const hint = outdated ? t('请升级到 {version} 或更新版本。', { version: minVersion }) : words ? words.hint : notFound ? reasonWords(notFound) : null;
      const places = missing ? placesOf(notFound) : [], step = !missing ? null
        : search?.scan === 'done' ? t('也搜索了所有本地磁盘。用下面的命令安装，装好后 Agentrix 会自己发现。')
          : search?.scan === 'partial' ? t('已搜索部分本地磁盘，下次启动会再搜索一次。用下面的命令安装，装好后 Agentrix 会自己发现。') : t('用下面的命令安装，装好后 Agentrix 会自己发现。');
      const file = installation?.installed && (search || manual) && installation.fileShown;
      const settled = !!agents && agents.installing !== agent;
      const version = installation?.version;
      const installedWords = outdated ? t('版本 {version} 过低', { version: version! })
        : manual ? [t('已安装'), version ? t('版本 {version}', { version }) : t('版本未知')].join(' · ') : t('已安装');
      const command = split?.incomplete ? installerCommand(isWindows) : npm ? `npm install -g ${npm}` : showInstructions && manual;
      return <div className="agent-setting" key={agent}>
      <div className="setting-row"><span className="agent-info"><b>{label}</b>
        <small role="status" className="agent-status" title={installation?.fileShown}>
          {!agents ? t('正在检测…') : npm && agents.installing === agent ? t('正在安装…') : words?.text ?? (installation?.installed
            ? installedWords : scanning ? t('正在搜索所有本地磁盘…') : t('未安装'))}
        </small>
        {settled && file && <small className="agent-path"><PathText text={file} /></small>}
        {settled && hint && <small className="agent-hint">{hint}</small>}
        {settled && places.map(place => <small className="agent-path" key={place}><PathText text={place} /></small>)}
        {settled && step && <small className="agent-hint">{step}</small>}</span>
        {npm && agents && !installation?.installed && <button type="button" className="button secondary small"
          disabled={pending || !!agents.installing || !agents.npm} onClick={() => void install(agent)}>{t('一键安装')}</button>}
        {showInstructions && <a className="button secondary small" href={page} target="_blank" rel="noreferrer">{t('官方安装说明')}</a>}</div>
      {command && <code className="agent-command">{command}</code>}
    </div>; })}
    {agents && !agents.npm && <div className="agents-node"><span>{t('需要先安装 Node.js')}</span><button type="button" className="button secondary small" onClick={() => void openNode()}>{t('下载 Node.js')}</button></div>}
    {(error || agents?.error) && <p className="form-error agents-error" role="alert">{error || agents?.error}</p>}
    {agents?.message && <p className="agents-message" role="status">{agents.message}</p>}
  </>;
}
