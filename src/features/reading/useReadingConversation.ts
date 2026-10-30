import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationEntry, ConversationPage, ReadingHistoryScope } from '../../shared/types';
import { createConversationBuffer } from './conversation-buffer';

export function conversationKey(id: string, sessionId: string | null) { return JSON.stringify([id, sessionId]); }

export function useReadingConversation(id: string, sessionId: string | null, enabled = true) {
  const key = conversationKey(id, sessionId);
  const [snapshot, setSnapshot] = useState<{ key: string; entries: ConversationEntry[] }>({ key, entries: [] });
  useEffect(() => {
    if (!enabled) return;
    const buffer = createConversationBuffer(entries => setSnapshot({ key, entries }));
    const off = window.agentrix.onTerminalConversation(packet => { if (packet.id === id) buffer.push(packet); });
    void window.agentrix.terminalConversation(id).then(result => buffer.snapshot(result.ok ? result.value : []), () => buffer.snapshot([]));
    return () => { buffer.dispose(); off(); };
  }, [id, key, enabled]);
  // A changed terminal must never paint the previous session while its request is pending.
  return enabled && snapshot.key === key ? snapshot.entries : [];
}

export function useReadingHistory(id: string, sessionId: string | null, scope?: ReadingHistoryScope | null) {
  const legacy = useReadingConversation(id, sessionId, !scope);
  const key = scope?.key ?? '', owner = useRef(sessionId); owner.current = sessionId;
  const [snapshot, setSnapshot] = useState<{ key: string; entries: ConversationEntry[]; page: ConversationPage | null; loading: boolean; error: string | null }>({ key, entries: [], page: null, loading: false, error: null });
  const current = useRef<{ key: string; load: () => Promise<boolean> } | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true, page: ConversationPage | null = null, loading = false;
    const buffer = createConversationBuffer(entries => { if (alive) setSnapshot(value => ({ ...value, key, entries, page, loading })); }, true);
    const fail = (message: string) => { if (alive) setSnapshot(value => ({ ...value, key, loading: false, error: message })); };
    const off = window.agentrix.onTerminalConversation(packet => {
      if (packet.id === id && packet.historyKey === key && (!owner.current || packet.sessionId === owner.current)) buffer.push(packet);
    });
    const load = async (older = false) => {
      if (loading || older && !page?.beforeCursor) return false;
      loading = true;
      setSnapshot(value => older ? { ...value, key, loading: true, error: null } : { key, entries: [], page: null, loading: true, error: null });
      try {
        const result = await window.agentrix.terminalConversationPage(id, { key, cursor: older ? page!.beforeCursor : null });
        if (!alive) return false;
        loading = false;
        if (!result.ok) { fail(result.error); if (!older) buffer.snapshot([]); return false; }
        if (result.value.key !== key) return false;
        page = result.value;
        if (older) buffer.prepend(page.entries); else buffer.snapshot(page.entries);
        setSnapshot(value => ({ ...value, key, page, loading: false, error: null }));
        return true;
      } catch { loading = false; fail('无法加载更早的对话，请重试。'); if (!older) buffer.snapshot([]); return false; }
    };
    current.current = { key, load: () => load(true) };
    void load();
    return () => { alive = false; buffer.dispose(); off(); if (current.current?.key === key) current.current = null; };
  }, [id, key]);
  const loadEarlier = useCallback(() => current.current?.key === key ? current.current.load() : Promise.resolve(false), [key]);
  const valid = snapshot.key === key;
  return { entries: key ? valid ? snapshot.entries : [] : legacy, paged: !!key, hasEarlier: !!key && valid && !!snapshot.page?.hasEarlier,
    loading: !!key && valid && snapshot.loading, error: key && valid ? snapshot.error : null, loadEarlier };
}
