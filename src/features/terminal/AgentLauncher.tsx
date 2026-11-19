import { routingModelName } from '../../shared/routing-command.ts';
import { useEffect, useState, type ReactNode } from 'react';
import { CircleNotch, Terminal as TerminalIcon } from '@phosphor-icons/react';
import type { AgentsState, Result, SeatsInfo } from '../../shared/types';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';
import { ClaudeLogo, CodexLogo } from '../agents/AgentBrandIcon.ts';
import { type NextPath, nativeBridge } from '../native-session/native-bridge.ts';
import { refreshNativeSession } from '../native-session/native-store.ts';
import './agent-launcher.css';

type Agent = 'claude' | 'codex';
type History = Record<Agent, { id: string; at: number } | null>;
const AGENTS: { agent: Agent; name: string; mark: ReactNode }[] = [{ agent: 'claude', name: 'Claude Code', mark: <ClaudeLogo size={22} /> }, { agent: 'codex', name: 'Codex', mark: <CodexLogo size={22} /> }];

// Routing labels describe the selected project. Loading those labels is independent of starting an agent.
function useLauncherRouting(projectId: string) {
  const [routing, setRouting] = useState<{ projectId: string; info: SeatsInfo | null } | null>(null);
  useEffect(() => {
    const api = window.agentrix;
    if (!api?.skillSeats) return;
    let active = true, request = 0;
    const load = () => {
      const mine = ++request;
      void api.skillSeats(projectId, null).then(
        info => { if (active && request === mine) setRouting({ projectId, info }); },
        () => { if (active && request === mine) setRouting(null); },
      );
    };
    load();
    const off = api.onSkills?.(load);
    return () => { active = false; off?.(); };
  }, [projectId]);
  return routing?.projectId === projectId ? routing.info : null;
}

// A project with no agent on the card: pick the agent to work with, fresh or continuing this folder's latest conversation
// with it. An agent not installed yet is installed by the same click (Node.js first, when even npm is missing), then
// started. An SSH project offers Codex only (Claude there is the owner's own in its terminal), which is not installed here and starts at once: the other
// computer says if it has none. A plain terminal (for other CLIs) stays one click away. By the settings (运行方式) the agent starts as a native session
// (Claude on the API key, Codex on its app-server) or, as before, in a terminal.
export function AgentLauncher({ terminalId, projectId, kind = 'local', onAction, onOpenTerminal, runningCount = 0, onExpand }: {
  terminalId: string; projectId: string; kind?: 'local' | 'ssh'; onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onOpenTerminal: (id: string) => void; runningCount?: number; onExpand?: () => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [mode, setMode] = useState<'new' | 'continue' | null>(null);
  const [starting, setStarting] = useState<Agent | 'terminal' | null>(null);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  // What main decided for a new Claude session in this project (usage's `next`): the card shows it and never works the path out itself.
  const [next, setNext] = useState<NextPath | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const routing = useLauncherRouting(projectId);
  useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge) return;
    let active = true;
    void bridge.usage(projectId).then(usage => { if (active && usage.ok) setNext(usage.value.agents.claude.next); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void window.agentrix.getAgents().then(result => { if (active && result.ok) setAgents(result.value); });
    const off = window.agentrix.onAgents(state => { if (active) setAgents(state); });
    return () => { active = false; off(); };
  }, []);
  // The Codex of a project on another computer (SSH) runs there, on that computer's app-server: whether this computer has Codex is none of its business.
  const remote = kind === 'ssh', runsHere = (agent: Agent) => !(remote && agent === 'codex');
  const missing = (agent: Agent) => runsHere(agent) && !!agents && !agents[agent].installed;
  // npm put Claude Code there without its native program: installing again changes nothing. With a key saved the connection test says why (the run-mode page, its test button in focus); without one the test cannot be clicked, and the page with the installer's command opens.
  const incomplete = (agent: Agent) => agent === 'claude' && runsHere(agent) && !!agents?.claude.incomplete;
  useEffect(() => {
    let active = true;
    void window.agentrix.agentHistory(terminalId).then(result => {
      if (!active) return;
      const found = result.ok ? result.value : { claude: null, codex: null };
      setHistory(found); setMode(current => current ?? (found.claude || found.codex ? 'continue' : 'new'));
    });
    return () => { active = false; };
  }, [terminalId]);
  const known = !!history && !!(history.claude || history.codex), chosen = mode ?? 'new';
  const prepareAgentTerminal = async () => {
    const state = await onAction(window.agentrix.getState());
    const terminal = state?.projects.find(project => project.id === projectId)?.terminals.find(terminal => terminal.id === terminalId);
    if (!terminal) return;
    if (!terminal.sessionId || terminal.status === 'exited') return terminalId;
    return onAction(window.agentrix.addTerminal(projectId, false));
  };
  // Main refuses a Claude start with no path only for a missing key under API-only: the card says so and starts nothing.
  const noKey = next?.reason === 'no_key';
  const launch = async (id: string, agent: Agent) => {
    const bridge = nativeBridge();
    if (agent === 'claude' && noKey && !next?.path) setNotice(t('只用 API 运行，但还没有保存 API key。请到设置的「运行方式」里保存。'));
    else if (bridge) {
      // A start that fails is told in the card it leaves (the session that failed shows its reason, or this card says it): not again as a message in the corner.
      const started = await bridge.start(id, { agent, resume: chosen === 'continue' }).catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
      if (!started.ok) setNotice(started.error);
      refreshNativeSession(id);
    } else await onAction(window.agentrix.agentLaunch(id, agent, chosen));
  };
  const start = async (what: Agent | 'terminal') => {
    if (starting) return;
    setStarting(what); setNotice(null);
    // Once started, the terminal (or the reading view) takes this card's place; a failure leaves it to try again.
    if (what === 'terminal') {
      await onAction(window.agentrix.startTerminal(terminalId));
      onOpenTerminal(terminalId);
    }
    else if (incomplete(what)) window.dispatchEvent(new CustomEvent('agentrix:open-settings', { detail: noKey ? { section: 'agents' } : { section: 'runtime', focus: true } }));
    else if (missing(what) && !agents?.npm) await onAction(window.agentrix.openNode());
    else {
      const installed = missing(what) ? await onAction(window.agentrix.installAgent(what)) : agents;
      if (installed) setAgents(installed);
      if (!runsHere(what) || installed?.[what].installed) {
        const id = await prepareAgentTerminal();
        if (id) await launch(id, what);
      }
    }
    setStarting(null);
  };
  const note = (agent: Agent) => {
    if (runsHere(agent) && agents?.installing === agent) return t('正在安装…');
    if (incomplete(agent)) return noKey ? t('安装不完整 · 点击查看') : t('安装不完整 · 去测试连接查看');
    if (missing(agent)) return agents!.npm ? t('未安装 · 点击一键安装') : t('未安装 · 需要先安装 Node.js');
    if (chosen === 'new') return t('开始新的对话');
    if (!history) return t('正在查找开发记录…');
    const last = history[agent];
    // An SSH project is not asked until the click: it may have a conversation this window does not know of, or know of one by its id only, with no time to say.
    if (remote && !last?.at) return t('接着上次的对话');
    return last ? t('接着上次的对话 · {time}', { time: relativeTime(last.at, Date.now()) }) : t('没有它的开发记录，将重新开始');
  };
  // Where a click would run the agent, said beside the choice when it is not the terminal it always was.
  const routeNote = (agent: Agent) => {
    if (missing(agent) || incomplete(agent)) return null;
    if (agent === 'codex') return t('原生模式');
    if (next?.path === 'api' || next?.path === 'native') return t('API · 原生模式');
    return noKey ? (next?.path ? t('没有 API key，改用终端') : t('需先保存 API key')) : null;
  };
  const choices = AGENTS.filter(({ agent }) => !remote || agent === 'codex');
  const primary = routing?.leadAgent;
  if (primary) choices.sort((a, b) => Number(b.agent === primary) - Number(a.agent === primary));
  const seatLabel = (agent: Agent) => {
    const seat = routing?.leads?.[agent];
    return seat ? t(agent === primary ? '总指挥 · {model}' : '默认 · {model}', { model: routingModelName(seat.model) }) : null;
  };
  return <div className="agent-launcher"><div className="agent-launcher-body">
    <p className="agent-launcher-title">{t('选择助手，开始开发')}</p>
    <div className="agent-launcher-mode" role="radiogroup" aria-label={t('开发方式')}>
      <button type="button" role="radio" aria-checked={chosen === 'new'} onClick={() => setMode('new')}>{t('开始新开发')}</button>
      <button type="button" role="radio" aria-checked={chosen === 'continue'} disabled={!known && !remote} title={history && !known && !remote ? t('这个文件夹还没有开发记录') : undefined} onClick={() => setMode('continue')}>{t('继承开发历史')}</button>
    </div>
    <div className="agent-launcher-agents">{choices.map(({ agent, name, mark }) => <button type="button" key={agent} data-routing-primary={agent === primary || undefined} className={`agent-launcher-agent is-${agent}${missing(agent) ? ' is-missing' : ''}`} disabled={!!starting || (runsHere(agent) && !!agents?.installing)} onClick={() => void start(agent)}>
      <span className="agent-launcher-mark" aria-hidden="true" data-audit-ignore>{starting === agent || (runsHere(agent) && agents?.installing === agent) ? <CircleNotch size={16} className="loading-spinner" /> : mark}</span>
      <b>{name}</b><small>{[seatLabel(agent), note(agent), routeNote(agent)].filter(Boolean).join(' · ')}</small>
    </button>)}</div>
    {(agents?.error || notice) && <p className="agent-launcher-error" role="alert">{agents?.error || notice}</p>}
    <div className="agent-launcher-more">
      <button type="button" className="text-button" disabled={!!starting} onClick={() => void start('terminal')}><TerminalIcon size={13} />{t('只打开终端')}</button>
    </div>
    {runningCount > 0 && <button type="button" className="text-button agent-launcher-running" onClick={onExpand}>{t('{count} 个终端运行中 · 点击展开', { count: runningCount })}</button>}
  </div></div>;
}
