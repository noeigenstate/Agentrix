import { useRef, useState } from 'react';
import type { NativeApproval } from '../../shared/types';
import { NativeQuestionCard } from './NativeQuestionCard';

const LABELS: Record<string, string> = { accept: 'Allow once', decline: 'Deny', cancel: 'Cancel turn', allow: 'Allow once', deny: 'Deny', grant: 'Grant requested permissions for this turn' };
const evidenceText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

// All evidence and actions come from the backend. Never correlate this card with a screen choice.
export function NativeApprovalCard({ request, source, onOpen, onError }: { request: NativeApproval; source?: string; onOpen?: () => void; onError: (message: string) => void }) {
  const p = request.params, input = p.input && typeof p.input === 'object' && !Array.isArray(p.input) ? p.input as Record<string, unknown> : undefined;
  const evidence = [
    ['Command', p.command ?? input?.command], ['Tool', p.tool_name], ['Tool input', p.input], ['Requested permissions', p.permissions],
    ['Reason', p.reason ?? p.decision_reason], ['Cwd', p.cwd ?? input?.cwd],
    ['File changes', p.changes ?? p.fileChanges], ['Access root', p.grantRoot],
  ].filter(([, value]) => value != null);
  const sending = useRef(false), [state, setState] = useState<'idle' | 'sent' | 'failed'>('idle');
  if (request.question) return <NativeQuestionCard request={request} source={source} onOpen={onOpen} onError={onError} />;
  const answer = async (decision: string) => {
    if (sending.current) return;
    sending.current = true; setState('sent');
    try {
      const result = await window.agentrix.answerNativeApproval(request.terminalId, { token: request.token, decision });
      if (!result.ok) { setState('failed'); onError(result.error); }
    } catch (error) { setState('failed'); onError(String(error)); }
  };
  return <section className="reading-choice is-permission" data-approval-mode="native" aria-label="Native CLI approval">
    <div className="reading-choice-head"><strong>{request.provider} · Native CLI approval</strong></div>
    {evidence.map(([label, value], index) => <div key={index}><p>{label as string}</p><pre className="reading-choice-context">{evidenceText(value)}</pre></div>)}
    {source && <p>{source}</p>}
    <div className="reading-choice-options">{request.decisions.map(decision => <button className="reading-choice-option" type="button" key={decision} disabled={state !== 'idle'} onClick={() => void answer(decision)}>{LABELS[decision] || decision}</button>)}</div>
    {state === 'failed' && <p role="status">This action is no longer available. Check the live session.</p>}
    {onOpen && <button type="button" className="text-button" onClick={onOpen}>Open source</button>}
    <details><summary>Native request details</summary><p>{request.method} · Request {typeof request.requestId} {JSON.stringify(request.requestId)}</p><pre className="reading-choice-context">{JSON.stringify(request.params, null, 2)}</pre></details>
  </section>;
}
