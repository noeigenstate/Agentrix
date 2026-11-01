import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../../shared/types';
import { newest } from './lab-store';

// Asks the bridge again whenever `key` changes (or reload() is called) and keeps only the newest answer: a slow answer to an earlier
// question never replaces a later one. `ask` returns null when there is nothing to ask yet.
export function useResult<T>(ask: () => Promise<Result<T>> | null, key: unknown[]) {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean }>({ value: null, error: null, loading: false });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(newest()).current, current = useRef(ask);
  current.current = ask;
  useEffect(() => {
    const call = current.current();
    if (!call) { setState({ value: null, error: null, loading: false }); return; }
    setState(previous => ({ ...previous, error: null, loading: true }));
    void latest(call).then(result => { if (result) setState(result.ok ? { value: result.value, error: null, loading: false } : { value: null, error: result.error, loading: false }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...key, nonce]);
  return { ...state, reload: useCallback(() => setNonce(value => value + 1), []) };
}
