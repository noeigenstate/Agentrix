import type { ReactNode } from 'react';
import { ClaudeLogo, CodexLogo } from '../agents/AgentBrandIcon.ts';

// Main rail nodes belong to user and agent turns. An agent's messages and tools live inside its body.
// Named heads always show their time; child items show it when the minute changes.
export const stepTime = (at: number | null | undefined) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

export function TimelineStep({ at, kind, mark, who, showTime = true, state, agent, latest = true, children }: {
  at: number | null | undefined; kind: 'user' | 'agent'; mark: ReactNode;
  who?: string; showTime?: boolean;
  // A node whose steps still run turns; one that failed is marked. agent: whose answer it is, which tints its node.
  state?: 'running' | 'failed' | null; agent?: 'claude' | 'codex' | null;
  // The newest round's step; earlier rounds' steps speak more quietly.
  latest?: boolean; children: ReactNode;
}) {
  const time = who || showTime ? stepTime(at) : '';
  const stamp = time ? <time dateTime={at ? new Date(at).toISOString() : undefined}>{time}</time> : null;
  return <div className={`reading-step is-${kind}${agent ? ` is-${agent}` : ''}${state ? ` is-${state}` : ''}${latest ? ' is-latest' : ''}`}>
    <span className="reading-node" aria-hidden="true">{mark}</span>
    <div className="reading-step-body">
      {(who || stamp) && <div className="reading-step-head">{who && <b className="reading-step-label">{who}</b>}{stamp}</div>}
      {children}
    </div>
  </div>;
}

export function AgentTurnItem({ at, kind, showTime, state, children }: {
  at: number | null | undefined; kind: 'message' | 'tools'; showTime: boolean;
  state?: 'running' | 'failed' | null; children: ReactNode;
}) {
  const time = showTime ? stepTime(at) : '';
  return <div className={`reading-turn-${kind}${state ? ` is-${state}` : ''}`}>
    <div className="reading-turn-item-body">
      {kind === 'message' && time && <time dateTime={at ? new Date(at).toISOString() : undefined}>{time}</time>}
      {children}
      {kind === 'tools' && time && <time dateTime={at ? new Date(at).toISOString() : undefined}>{time}</time>}
    </div>
  </div>;
}

// Compatibility for existing conversation imports; the mark is the official Claude vector.
export const ClaudeSpark = ClaudeLogo;

// The agent's mark on its replies' nodes.
export const AgentMark = ({ agent }: { agent: 'claude' | 'codex' }) => agent === 'claude' ? <ClaudeSpark /> : <CodexLogo />;
