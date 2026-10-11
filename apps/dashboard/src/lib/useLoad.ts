import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isAbort } from './format';

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: T };

export interface Loaded<T> {
  state: LoadState<T>;
  reload: () => void;
  /** Replace the loaded data in place, e.g. after a successful write. No-op unless ready. */
  setData: Dispatch<SetStateAction<T>>;
}

/**
 * Runs `load` on mount and whenever `key` changes. The previous request is
 * aborted first, so a slow response for an old site can never overwrite the
 * view for the current one.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    load(ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (!ctrl.signal.aborted && !isAbort(error)) setState({ status: 'error', error });
      },
    );
    return () => ctrl.abort();
    // `load` is deliberately not a dependency: it is a fresh closure every
    // render, and `key` is what identifies the request.
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const setData = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setState((prev) => {
      if (prev.status !== 'ready') return prev;
      const data = typeof next === 'function' ? (next as (value: T) => T)(prev.data) : next;
      return { status: 'ready', data };
    });
  }, []);

  return { state, reload, setData };
}
