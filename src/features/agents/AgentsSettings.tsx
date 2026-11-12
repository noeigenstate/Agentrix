import { useState } from 'react';
import type { AgentsState, ClaudeFound } from '../../shared/types';
import { t } from '../../shared/i18n';
import { viaWords } from '../native-session/native-words';

const api = window.agentrix;
// What an installed agent reads as: Claude Code says which install the terminal runs, a split (the native path runs another),
// an install that cannot run (too old, a failed check, npm's package without its native program) and where to look.
const found = ({ version, via }: Partial<ClaudeFound>) => [version ? t('版本 {version}', { version }) : t('版本未知'), via && t('来自 {via}', { via: viaWords(via) })].filter(Boolean).join(' · ');
function installedWords(agent: 'codex' | 'claude', state: AgentsState): { text: string; hint: string | null } {
  const claude = state.claude, testHint = t('到「运行方式 › 测试连接」查看原因。');
  if (agent === 'codex') return { text: t('已安装'), hint: null };
  if (claude.incomplete) return { text: t('安装不完整'), hint: t('npm 装了，但里面没有原生程序。{hint}', { hint: testHint }) };
  if (claude.reason === 'too_old') return { text: [claude.version ? t('版本 {version} 过低', { version: claude.version }) : t('版本过低'), claude.via && t('来自 {via}', { via: viaWords(claude.via) })].filter(Boolean).join(' · '), hint: t('请升级 Claude Code。') };
  if (claude.reason) return { text: t('已安装 · 检查未通过'), hint: testHint };
  if (claude.notice === 'cli_split_versions' && claude.native) return { text: `${t('终端')} · ${found(claude)}`, hint: t('原生用的是另一份：{found}', { found: found(claude.native) }) };
  return { text: [t('已安装'), claude.version && t('版本 {version}', { version: claude.version }), claude.via && t('来自 {via}', { via: viaWords(claude.via) })].filter(Boolean).join(' · '), hint: null };
}
export function AgentsSettings({ agents, onChange }: { agents: AgentsState | null; onChange: (state: AgentsState) => void }) {
  const [pending, setPending] = useState(false);
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
    {(['codex', 'claude'] as const).map(agent => { const words = agents?.[agent].installed ? installedWords(agent, agents) : null; return <div className="agent-setting" key={agent}>
      <div className="setting-row"><span><span><b>{agent === 'codex' ? 'Codex CLI' : 'Claude Code'}</b><small role="status" title={agent === 'claude' ? agents?.claude.fileShown : undefined}>{!agents ? t('正在检测…') : agents.installing === agent ? t('正在安装…') : words ? words.text : t('未安装')}</small>
        {agents?.installing !== agent && words?.hint && <small>{words.hint}</small>}</span></span>
        {agents && !agents[agent].installed && <button type="button" className="button secondary small" disabled={pending || !!agents.installing || !agents.npm} onClick={() => void install(agent)}>{t('一键安装')}</button>}</div>
      <code className="agent-command">{agent === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code'}</code>
    </div>; })}
    {agents && !agents.npm && <div className="agents-node"><span>{t('需要先安装 Node.js')}</span><button type="button" className="button secondary small" onClick={() => void openNode()}>{t('下载 Node.js')}</button></div>}
    {(error || agents?.error) && <p className="form-error agents-error" role="alert">{error || agents?.error}</p>}
    {agents?.message && <p className="agents-message" role="status">{agents.message}</p>}
  </>;
}
