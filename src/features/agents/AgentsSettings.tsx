import { useState } from 'react';
import type { AgentsState } from '../../shared/types';
import { t } from '../../shared/i18n';
import { viaWords } from '../native-session/native-words';

const api = window.agentrix;
// Installed, and for Claude Code where main found it; a field main did not give is left out.
const installedWords = ({ version, via }: AgentsState['claude']) => [t('已安装'), version && t('版本 {version}', { version }), via && t('来自 {via}', { via: viaWords(via) })].filter(Boolean).join(' · ');
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
    {(['codex', 'claude'] as const).map(agent => <div className="agent-setting" key={agent}>
      <div className="setting-row"><span><span><b>{agent === 'codex' ? 'Codex CLI' : 'Claude Code'}</b><small role="status" title={agent === 'claude' ? agents?.claude.fileShown : undefined}>{!agents ? t('正在检测…') : agents.installing === agent ? t('正在安装…') : agents[agent].installed ? installedWords(agents[agent]) : t('未安装')}</small></span></span>
        {agents && !agents[agent].installed && <button type="button" className="button secondary small" disabled={pending || !!agents.installing || !agents.npm} onClick={() => void install(agent)}>{t('一键安装')}</button>}</div>
      <code className="agent-command">{agent === 'codex' ? 'npm install -g @openai/codex' : 'npm install -g @anthropic-ai/claude-code'}</code>
    </div>)}
    {agents && !agents.npm && <div className="agents-node"><span>{t('需要先安装 Node.js')}</span><button type="button" className="button secondary small" onClick={() => void openNode()}>{t('下载 Node.js')}</button></div>}
    {(error || agents?.error) && <p className="form-error agents-error" role="alert">{error || agents?.error}</p>}
    {agents?.message && <p className="agents-message" role="status">{agents.message}</p>}
  </>;
}
