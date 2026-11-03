// The samples of the chosen sources: one question to the bridge per source, each asked once the form has reached step 2 and kept when the owner steps back;
// only a change to what that source's sample depends on (its scope, size, short-and-complex preference or the tasks set aside) asks again. The sampled tasks
// are put into the draft, and each source gets the props its panel shows.
import { useState } from 'react';
import type { LabBridge, LabSampleQuery, LabSource, LabSourceInfo } from '../../shared/lab-types';
import { friendlyError } from './format';
import { SOURCE_ORDER } from './source-math';
import type { PanelProps } from './SourcePanels';
import { useResult } from './useResult';
import { availableSources, clampSize, sampleQuery, sizeRange, withTasks, type Draft } from './wizard-math';

type Sampling = { size: number | null; exclude: string[]; preferShortComplex: boolean };
// A size of null is the source's own standard, known once the source has said it.
const fresh = (): Sampling => ({ size: null, exclude: [], preferShortComplex: false });
const initial = (): Record<LabSource, Sampling> => ({ history: fresh(), oss: fresh(), aa: fresh() });

const useSample = (api: Pick<LabBridge, 'sample'>, query: LabSampleQuery | null) => useResult(() => query ? api.sample(query) : null, [JSON.stringify(query)]);

export function useSamples({ api, infos, projects, base, active }: {
  api: Pick<LabBridge, 'sample'>; infos: LabSourceInfo[] | null; projects: { id: string; name: string }[]; base: Draft; active: boolean;
}) {
  const [sampling, setSampling] = useState(initial);
  // The draft as the form shows it: only the sources that can run, the first project and the first benchmark until the owner picks another.
  const available = availableSources(infos);
  const scoped: Draft = {
    ...base, sources: base.sources.filter(source => available.includes(source)),
    history: { ...base.history, projectId: base.history.projectId || projects[0]?.id || '' },
    aa: { ...base.aa, benchmark: base.aa.benchmark || infos?.find(info => info.id === 'aa')?.options[0]?.id || '' },
  };
  const sizeOf = (source: LabSource) => sampling[source].size ?? sizeRange(infos, source).standard;
  const ask = (source: LabSource) => active && scoped.sources.includes(source) ? sampleQuery(scoped, source, sizeOf(source), sampling[source].exclude, sampling[source].preferShortComplex) : null;
  const results = { history: useSample(api, ask('history')), oss: useSample(api, ask('oss')), aa: useSample(api, ask('aa')) };
  const draft = withTasks(scoped, { history: results.history.value ?? [], oss: results.oss.value ?? [], aa: results.aa.value ?? [] });

  // Every change starts the source's tasks-set-aside list afresh, unless it sets one.
  const change = (source: LabSource, patch: Partial<Sampling>) => setSampling(current => ({ ...current, [source]: { ...current[source], exclude: [], ...patch } }));
  const panel = (source: LabSource): PanelProps => {
    const range = sizeRange(infos, source), tasks = draft[source].tasks, { loading, error, reload } = results[source], { exclude } = sampling[source];
    return {
      sample: { tasks, loading, error: error && friendlyError(error), exhausted: exclude.length > 0 && !loading && !error && tasks.length === 0 },
      size: sizeOf(source), range, onSize: size => change(source, { size: clampSize(size, range) }),
      onShuffle: () => change(source, { exclude: tasks.map(task => task.id) }),
      onRetry: () => { if (exclude.length) change(source, {}); else reload(); },
    };
  };
  return {
    draft, panels: Object.fromEntries(SOURCE_ORDER.map(source => [source, panel(source)])) as Record<LabSource, PanelProps>,
    loading: Object.values(results).some(result => result.loading), preferShortComplex: sampling.history.preferShortComplex,
    onPrefer: (preferShortComplex: boolean) => change('history', { preferShortComplex }), onRescope: (source: LabSource) => change(source, {}),
  };
}
