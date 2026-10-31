// What the dashboard window knows: its query, the summary the main process last returned and the main window's look.
// A plain store (no React) so the reading rules are testable with a stubbed bridge.
import type { DashboardAppearance, DashboardBridge, DashboardQuery, DashboardSuggestion, DashboardSummary } from '../../shared/dashboard-types';
import type { Result } from '../../shared/types';

export type DashboardState = { query: DashboardQuery; summary: DashboardSummary | null; error: string | null; appearance: DashboardAppearance | null };

export const DEFAULT_QUERY: DashboardQuery = { projectId: null, range: '30d' };

export function createDashboardStore(bridge: DashboardBridge) {
  let state: DashboardState = { query: DEFAULT_QUERY, summary: null, error: null, appearance: null };
  let generation = 0, stops: (() => void)[] = [];
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DashboardState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };

  // The newest request wins: a slow answer to an earlier query never replaces a later one.
  async function apply(call: Promise<Result<DashboardSummary>>) {
    const mine = ++generation;
    const result = await call.catch((error: unknown): Result<DashboardSummary> => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (mine === generation) set(result.ok ? { summary: result.value, error: null } : { error: result.error });
    return result;
  }
  const load = () => apply(bridge.summary(state.query));

  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Reads the first summary and follows the main window's appearance and new records until stop().
    start() {
      stops = [bridge.onChanged(() => void load()), bridge.onAppearance(appearance => set({ appearance }))];
      void bridge.appearance().then(result => { if (result.ok && !state.appearance) set({ appearance: result.value }); }, () => undefined);
      void load();
    },
    stop() { stops.forEach(stop => stop()); stops = []; generation++; },
    setQuery(patch: Partial<DashboardQuery>) { set({ query: { ...state.query, ...patch } }); void load(); },
    // Adopt, dismiss or reopen a suggestion; the page then shows the summary the main process returns. Resolves to the error, if any.
    async decide(id: string, next: DashboardSuggestion['state']) {
      const result = await apply(bridge.decide(id, next, state.query));
      return result.ok ? null : result.error;
    },
  };
}

export type DashboardStore = ReturnType<typeof createDashboardStore>;
