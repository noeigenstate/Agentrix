import { modelLabel, routingModelName } from '../../shared/routing-command.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleNotch, Terminal as TerminalIcon } from '@phosphor-icons/react';
import type { AgentsState, NativeHistorySession, Result, SeatsInfo } from '../../shared/types';
import type { AgentProvider } from '../../shared/agent-events';
import { relativeTime } from '../../shared/time';
import { t } from '../../shared/i18n';
import { Select } from '../../shared/Select';
import { brandIconOf } from '../agents/AgentBrandIcon.ts';
import { type NativeUsage, nativeBridge } from '../native-session/native-bridge.ts';
import { refreshNativeSession } from '../native-session/native-store.ts';
import { reasonWords } from '../native-session/native-words.ts';
import { adapterOf, adapters } from '../../../electron/features/cli-adapters/registry.mjs';
import { canLead, support } from '../../../electron/features/cli-adapters/capabilities.mjs';
import './agent-launcher.css';

type History = Partial<Record<AgentProvider, { id: string; at: number } | null>>;
const AGENTS = adapters().filter(({ manifest }) => canLead(manifest)).map(({ manifest }) => {
  const { id: agent, label: name, brand, install } = manifest;
  const Mark = brand ? brandIconOf(agent) : TerminalIcon;
  return { agent, name, mark: <Mark size={22} />, manual: !install.npm, native: support(manifest, 'native').ok,
    remoteNative: support(manifest, 'ssh.native').ok };
});
const hasHistory = (history: History) => AGENTS.some(({ agent }) => !!history[agent]);

function useNativeHistory(terminalId: string, agent: AgentProvider | undefined, eager: boolean) {
  const [read, setRead] = useState<{ terminalId: string; agent: AgentProvider; result: Result<NativeHistorySession[]> | null } | null>(null);
  const pending = useRef<{ terminalId: string; agent: AgentProvider; result: Promise<Result<NativeHistorySession[]> | null> } | null>(null);
  const load = useCallback(() => {
    const history = nativeBridge()?.history;
    if (!agent || !history) return Promise.resolve(null);
    if (pending.current?.terminalId === terminalId && pending.current.agent === agent) return pending.current.result;
    setRead({ terminalId, agent, result: null });
    const result = Promise.resolve().then(() => history(terminalId, agent))
      .catch(() => ({ ok: false as const, error: t('无法读取会话历史。') })).then(result => {
        if (pending.current !== entry) return null;
        if (!result.ok) pending.current = null;
        setRead({ terminalId, agent, result });
        return result;
      });
    const entry = { terminalId, agent, result };
    pending.current = entry;
    return result;
  }, [agent, terminalId]);
  useEffect(() => () => { pending.current = null; }, [terminalId, agent]);
  useEffect(() => { if (eager) void load(); }, [eager, load]);
  const current = read?.terminalId === terminalId && read.agent === agent ? read : null;
  return { result: current?.result ?? null, loading: current !== null && current.result === null, load };
}

// Routing labels describe the selected project. Loading those labels is independent of starting an agent.
function useLauncherRouting(projectId: string) {
  const [routing, setRouting] = useState<{ projectId: string; info: SeatsInfo | null } | null>(null);
  useEffect(() => {
    const api = window.agentrix;
    if (!api?.routingSeats) return;
    let active = true, request = 0;
    const load = () => {
      const mine = ++request;
      void api.routingSeats(projectId, null).then(
        info => { if (active && request === mine) setRouting({ projectId, info }); },
        () => { if (active && request === mine) setRouting(null); },
      );
    };
    load();
    const off = api.onRouting?.(load);
    return () => { active = false; off?.(); };
  }, [projectId]);
  return routing?.projectId === projectId ? routing.info : null;
}

// A project with no agent on the card: pick the agent to work with, fresh or continuing this folder's latest conversation
// with it. An agent not installed yet is installed by the same click (Node.js first, when even npm is missing), then
// started. SSH launch choices use the remote CLI's capabilities and leave installation checks to the host.
export function AgentLauncher({ terminalId, projectId, kind = 'local', onAction, onOpenTerminal, runningCount = 0, onExpand }: {
  terminalId: string; projectId: string; kind?: 'local' | 'ssh'; onAction: <T,>(promise: Promise<Result<T>>) => Promise<T | undefined>;
  onOpenTerminal: (id: string) => void; runningCount?: number; onExpand?: () => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [mode, setMode] = useState<'new' | 'continue' | null>(null);
  const [starting, setStarting] = useState<AgentProvider | 'terminal' | null>(null);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  // What main decided for a new Claude session in this project (usage's `next`): the card shows it and never works the path out itself.
  const [routes, setRoutes] = useState<NativeUsage['agents'] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const routing = useLauncherRouting(projectId);
  useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge) return;
    let active = true;
    void bridge.usage(projectId).then(usage => { if (active && usage.ok) setRoutes(usage.value.agents); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    let changed = false;
    const off = window.agentrix.onAgents(state => { changed = true; if (active) setAgents(state); });
    void window.agentrix.getAgents().then(result => { if (active && !changed && result.ok) setAgents(result.value); }, () => {});
    return () => { active = false; off(); };
  }, []);
  const remote = kind === 'ssh';
  const missing = (agent: AgentProvider) => !remote && !!agents && !agents[agent]?.installed;
  const choices = AGENTS.filter(({ agent, manual, remoteNative }) =>
    !manual || !!nativeBridge() && (remote ? remoteNative : agents?.[agent]?.installed));
  // npm put Claude Code there without its native program: installing again changes nothing. With a key saved the connection test says why (the run-mode page, its test button in focus); without one the test cannot be clicked, and the page with the installer's command opens.
  const incomplete = (agent: AgentProvider) => {
    const installation = agents?.[agent];
    return !remote && !!installation && 'incomplete' in installation && !!installation.incomplete;
  };
  useEffect(() => {
    let active = true;
    void window.agentrix.agentHistory(terminalId).then(result => {
      if (!active) return;
      const found = result.ok ? result.value : {};
      setHistory(found);
    }, () => { if (active) setHistory({}); });
    return () => { active = false; };
  }, [terminalId]);
  const known = !!history && hasHistory(history), chosen = mode ?? (known ? 'continue' : 'new');
  const nativeHistoryAgent = choices.find(({ manual, native }) => manual && native)?.agent;
  const canReadHistory = !!nativeHistoryAgent && !!nativeBridge()?.history && !!nativeBridge()?.resume;
  const { result: nativeHistory, loading: historyRequested, load: loadNativeHistory } =
    useNativeHistory(terminalId, chosen === 'continue' && canReadHistory ? nativeHistoryAgent : undefined, !remote);
  const sessions = nativeHistory?.ok ? nativeHistory.value : [];
  const resumeSession = sessions.find(session => session.id === selectedSession) ?? sessions[0];
  const historyError = nativeHistory?.ok === false ? reasonWords(nativeHistory.error) ?? nativeHistory.error : null;
  const prepareAgentTerminal = async () => {
    const state = await onAction(window.agentrix.getState());
    const terminal = state?.projects.find(project => project.id === projectId)?.terminals.find(terminal => terminal.id === terminalId);
    if (!terminal) return;
    if (!terminal.sessionId || terminal.status === 'exited') return terminalId;
    return onAction(window.agentrix.addTerminal(projectId, false));
  };
  // Main refuses a Claude start with no path only for a missing key under API-only: the card says so and starts nothing.
  const noKey = (agent: AgentProvider) => routes?.[agent]?.next?.reason === 'no_key';
  const launch = async (id: string, agent: AgentProvider, resumeId?: string) => {
    const bridge = nativeBridge();
    const manifest = adapterOf(agent)!.manifest;
    if (noKey(agent) && !routes?.[agent]?.next?.path) setNotice(t('只用 API 运行，但还没有保存 API key。请到设置的「运行方式」里保存。'));
    else if (bridge && support(manifest, remote ? 'ssh.native' : 'native').ok) {
      // A start that fails is told in the card it leaves (the session that failed shows its reason, or this card says it): not again as a message in the corner.
      const call = agent === nativeHistoryAgent
        ? resumeId ? bridge.resume?.(id, { agent, sessionId: resumeId }) : bridge.start(id, { agent })
        : bridge.start(id, { agent, resume: chosen === 'continue' });
      const started = await call?.catch(error => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
      if (!started?.ok) setNotice(reasonWords(started?.error) ?? started?.error ?? t('当前版本还不支持这个命令'));
      refreshNativeSession(id);
    } else await onAction(window.agentrix.agentLaunch(id, agent, chosen));
  };
  const start = async (what: AgentProvider | 'terminal') => {
    if (starting) return;
    setStarting(what); setNotice(null);
    // Once started, the terminal (or the reading view) takes this card's place; a failure leaves it to try again.
    if (what === 'terminal') {
      await onAction(window.agentrix.startTerminal(terminalId));
      onOpenTerminal(terminalId);
    }
    else if (incomplete(what)) window.dispatchEvent(new CustomEvent('agentrix:open-settings', { detail: noKey(what) ? { section: 'agents' } : { section: 'runtime', focus: true } }));
    else if (missing(what) && !agents?.npm) await onAction(window.agentrix.openNode());
    else {
      const installed = missing(what) ? await onAction(window.agentrix.installAgent(what)) : agents;
      if (installed) setAgents(installed);
      if (remote || installed?.[what]?.installed) {
        const needsHistory = chosen === 'continue' && what === nativeHistoryAgent;
        const read = needsHistory ? nativeHistory ?? await loadNativeHistory() : null;
        if (!needsHistory || read?.ok) {
          const id = await prepareAgentTerminal();
          if (id) await launch(id, what, resumeSession?.id ?? (read?.ok ? read.value[0]?.id : undefined));
        }
      }
    }
    setStarting(null);
  };
  const note = (agent: AgentProvider) => {
    if (!remote && agents?.installing === agent) return t('正在安装…');
    if (incomplete(agent)) return noKey(agent) ? t('安装不完整 · 点击查看') : t('安装不完整 · 去测试连接查看');
    if (missing(agent)) return agents!.npm ? t('未安装 · 点击一键安装') : t('未安装 · 需要先安装 Node.js');
    if (chosen === 'new') return t('开始新的对话');
    if (agent === nativeHistoryAgent && remote && !nativeHistory && !historyRequested) return t('接着上次的对话');
    if (agent === nativeHistoryAgent) return !canReadHistory ? t('当前版本还不支持这个命令') : nativeHistory === null ? t('正在查找开发记录…')
      : !nativeHistory.ok ? t('无法读取会话历史。')
        : resumeSession ? t('接着上次的对话') : t('没有它的开发记录，将重新开始');
    if (!history) return t('正在查找开发记录…');
    const last = history[agent];
    // An SSH project is not asked until the click: it may have a conversation this window does not know of, or know of one by its id only, with no time to say.
    if (remote && !last?.at) return t('接着上次的对话');
    return last ? t('接着上次的对话 · {time}', { time: relativeTime(last.at, Date.now()) }) : t('没有它的开发记录，将重新开始');
  };
  // Where a click would run the agent, said beside the choice when it is not the terminal it always was.
  const routeNote = (agent: AgentProvider) => {
    if (missing(agent) || incomplete(agent)) return null;
    const manifest = adapterOf(agent)!.manifest, next = routes?.[agent]?.next;
    if (!support(manifest, 'terminal').ok && support(manifest, 'native').ok) return t('原生模式');
    if (remote) return t('远端终端');
    if (next?.path === 'api' || next?.path === 'native') return t('API · 原生模式');
    return noKey(agent) ? (next?.path ? t('没有 API key，改用终端') : t('需先保存 API key')) : null;
  };
  const primary = routing?.leadAgent;
  const installError = remote ? null : agents?.error;
  if (primary) choices.sort((a, b) => Number(b.agent === primary) - Number(a.agent === primary));
  const seatLabel = (agent: AgentProvider) => {
    const seat = routing?.leads?.[agent];
    // In native mode the CLI picks its own model, so no seat is named.
    return seat && routing?.conductor ? t(agent === primary ? '总指挥 · {model}' : '默认 · {model}', { model: routing.catalog ? modelLabel(routing.catalog, seat.model) : routingModelName(seat.model) }) : null;
  };
  return <div className="agent-launcher"><div className="agent-launcher-body">
    <p className="agent-launcher-title">{t('选择助手，开始开发')}</p>
    <div className="agent-launcher-mode" role="radiogroup" aria-label={t('开发方式')}>
      <button type="button" role="radio" aria-checked={chosen === 'new'} onClick={() => setMode('new')}>{t('开始新开发')}</button>
      <button type="button" role="radio" aria-checked={chosen === 'continue'} disabled={!known && !remote && !canReadHistory}
        title={history && !known && !remote && !canReadHistory ? t('这个文件夹还没有开发记录') : undefined} onClick={() => setMode('continue')}>{t('继承开发历史')}</button>
    </div>
    {chosen === 'continue' && (resumeSession || remote && canReadHistory) && <Select label={t('Antigravity 历史会话')} value={resumeSession?.id ?? ''}
      disabled={!!starting} onOpen={loadNativeHistory}
      options={sessions.length ? sessions.map(({ id, title, at }) => ({ value: id, label: title || t('无标题会话'),
        description: at === null ? undefined : relativeTime(at, Date.now()) })) : [{ value: '', disabled: true,
        label: historyRequested ? t('正在查找开发记录…') : nativeHistory?.ok ? t('没有它的开发记录，将重新开始') : t('Antigravity 历史会话') }]}
      onChange={setSelectedSession} />}
    <div className="agent-launcher-agents">{choices.map(({ agent, name, mark }) => <button type="button" key={agent} data-routing-primary={agent === primary || undefined}
      className={`agent-launcher-agent is-${agent}${missing(agent) ? ' is-missing' : ''}`}
      disabled={!!starting || (!remote && !!agents?.installing) || chosen === 'continue' && agent === nativeHistoryAgent &&
        (!canReadHistory || nativeHistory?.ok === false || !remote && !nativeHistory)}
      onClick={() => void start(agent)}>
      <span className="agent-launcher-mark" aria-hidden="true" data-audit-ignore>
        {starting === agent || (!remote && agents?.installing === agent) ? <CircleNotch size={16} className="loading-spinner" /> : mark}
      </span>
      <b>{name}</b><small>{[seatLabel(agent), note(agent), routeNote(agent)].filter(Boolean).join(' · ')}</small>
    </button>)}</div>
    {(installError || notice || historyError) && <p className="agent-launcher-error" role="alert">{installError || notice || historyError}</p>}
    <div className="agent-launcher-more">
      <button type="button" className="text-button" disabled={!!starting} onClick={() => void start('terminal')}><TerminalIcon size={13} />{t('只打开终端')}</button>
    </div>
    {runningCount > 0 && <button type="button" className="text-button agent-launcher-running" onClick={onExpand}>{t('{count} 个终端运行中 · 点击展开', { count: runningCount })}</button>}
  </div></div>;
}
