import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result } from '../../shared/types';
import { newest } from './lab-store';

// Asks the bridge again whenever `key` changes (or reload() is called) and keeps only the newest answer: a slow answer to an earlier
// question never replaces a later one. `ask` returns null when there is nothing to ask yet.
// `fresh` says the answer held is to the question `key` asks now: the moment `key` changes it is false, before the new question is even sent,
// so something that must not act on an old answer (starting an experiment on an old estimate) checks it.
export function useResult<T>(ask: () => Promise<Result<T>> | null, key: unknown[]) {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean; answered: string | null }>({ value: null, error: null, loading: false, answered: null });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(newest()).current, current = useRef(ask), asked = JSON.stringify(key);
  current.current = ask;
  useEffect(() => {
    const call = current.current();
    if (!call) { setState({ value: null, error: null, loading: false, answered: null }); return; }
    setState(previous => ({ ...previous, error: null, loading: true }));
    void latest(call).then(result => { if (result) setState(result.ok ? { value: result.value, error: null, loading: false, answered: asked } : { value: null, error: result.error, loading: false, answered: asked }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...key, nonce]);
  return { value: state.value, error: state.error, loading: state.loading, fresh: state.answered === asked, reload: useCallback(() => setNonce(value => value + 1), []) };
}
