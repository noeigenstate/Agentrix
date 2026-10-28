import { useRef, useState } from 'react';
import type { ProjectTerminal } from '../../shared/types';
import { NativeApprovalCard } from './NativeApprovalCard';
import { PathText } from './PathText';
import { useReadingPaths } from './useReadingPaths';

export function ManagedSession({ projectId, terminal, onError }: { projectId: string; terminal: ProjectTerminal; onError: (message: string) => void }) {
  const pathLinks = useReadingPaths(projectId, onError);
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), sending = useRef(false);
  const send = async () => {
    if (sending.current || !terminal.sessionId || !text.trim()) return;
    sending.current = true; setBusy(true);
    try {
      const result = await window.agentrix.managedPrompt(terminal.id, terminal.sessionId, text);
      if (result.ok) setText(''); else onError(result.error);
    } catch (error) { onError(String(error)); }
    finally { sending.current = false; setBusy(false); }
  };
  return <div className="reading-view" {...pathLinks}>
    <header className="reading-choice"><strong>Claude SDK · Managed session</strong><p>Structured conversation and native tool approvals. Interactive TUI commands, session resume and terminal input are unavailable in this mode.</p></header>
    <div className="reading-scroll"><div className="reading-content">{terminal.nativeMessages?.map((message, index) => <section key={index}><strong>{message.role}</strong><pre style={{ whiteSpace: 'pre-wrap' }}><PathText text={message.text} /></pre></section>)}</div></div>
    {terminal.nativeApprovals?.map(request => <NativeApprovalCard key={request.token} request={request} onError={onError} />)}
    {terminal.error && <p role="alert">{terminal.error}</p>}
    <div className="reading-composer"><textarea aria-label="Message managed Claude session" value={text} onChange={event => setText(event.target.value)} disabled={!terminal.nativeReady || terminal.status === 'exited'} />
      <button type="button" className="button primary" disabled={busy || !text.trim() || !terminal.nativeReady || terminal.status === 'exited' || terminal.codexActivity === 'working' || !!terminal.nativeApprovals?.length} onClick={() => void send()}>Send</button></div>
  </div>;
}
