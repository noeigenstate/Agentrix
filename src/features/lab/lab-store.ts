// What the lab window knows: the experiments the main process last sent, the projects and sources it can sample, and the main window's look.
// A plain store (no React) so the reading rules are testable with a stubbed bridge.
import type { LabAppearance, LabBridge, LabExperiment, LabExperimentInput, LabSourceInfo } from '../../shared/lab-types';
import type { Result } from '../../shared/types';

export type LabState = {
  experiments: LabExperiment[] | null; projects: { id: string; name: string }[]; sources: LabSourceInfo[] | null; error: string | null; appearance: LabAppearance | null;
};

export const settle = <T>(call: Promise<Result<T>>): Promise<Result<T>> =>
  call.catch((error: unknown): Result<T> => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

// The newest request wins: the returned function resolves to null when a later call has been made since, so a slow answer never replaces a later one.
export function newest() {
  let latest = 0;
  return async <T>(call: Promise<Result<T>>): Promise<Result<T> | null> => {
    const mine = ++latest, result = await settle(call);
    return mine === latest ? result : null;
  };
}

export function createLabStore(bridge: LabBridge) {
  let state: LabState = { experiments: null, projects: [], sources: null, error: null, appearance: null };
  let stops: (() => void)[] = [];
  const listeners = new Set<() => void>();
  const set = (patch: Partial<LabState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const list = newest(), sourceList = newest();
  // A push from the main process and a list() answer are the same kind of news: whichever was asked or sent last is what the page shows.
  const read = async (call: Promise<Result<LabExperiment[]>>) => {
    const result = await list(call);
    if (result) set(result.ok ? { experiments: result.value, error: null } : { error: result.error });
  };
  const loadSources = async () => {
    const result = await sourceList(bridge.sources());
    if (result) set(result.ok ? { sources: result.value } : { error: result.error });
  };
  const refresh = () => Promise.all([read(bridge.list()), loadSources()]).then(() => undefined);

  async function act(call: Promise<Result<unknown>>) {
    const result = await settle(call);
    await refresh();
    return result.ok ? null : result.error;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      stops = [
        bridge.onChange(experiments => { void read(Promise.resolve({ ok: true, value: experiments })); }),
        bridge.onAppearance(appearance => set({ appearance })),
      ];
      void bridge.appearance().then(result => { if (result.ok && !state.appearance) set({ appearance: result.value }); }, () => undefined);
      void settle(bridge.projects()).then(result => { if (result.ok) set({ projects: result.value }); else set({ error: result.error }); });
      void refresh();
    },
    stop() { stops.forEach(stop => stop()); stops = []; },
    refresh,
    // Stores or clears the owner's AA key. The key is only passed through: it is never held in the state, and an error never repeats it. Resolves to the error
    // message, or null; the sources are asked again so the page shows what main says is stored.
    async saveAaKey(key: string | null) {
      const result = await settle(bridge.aaKey(key));
      if (!result.ok) return key ? result.error.split(key).join('…') : result.error;
      await loadSources();
      return null;
    },
    // Each of these resolves to the error message, or null when the main process did it.
    stopExperiment: (id: string) => act(bridge.stop(id)),
    remove: (id: string) => act(bridge.remove(id)),
    async begin(input: LabExperimentInput): Promise<Result<string>> {
      const result = await settle(bridge.start(input));
      if (result.ok) await refresh();
      return result;
    },
  };
}

export type LabStore = ReturnType<typeof createLabStore>;
