// One source's part of a screen that shows several: its name and scope, its state, and its own spend against its own budget.
import type { ReactNode } from 'react';
import type { LabExperiment, LabLane } from '../../shared/lab-types';
import { t } from '../../shared/i18n';
import { money } from './format';
import { Tag } from './Marks';
import { sliceExperiment } from './source-math';
import { LANE_STATES, SOURCE_NAMES } from './source-text';

const TONES = { running: 'running', done: 'success', stopped: 'warning', error: 'danger' } as const;

function LaneSection({ lane, children }: { lane: LabLane; children: ReactNode }) {
  const tone = lane.state === 'queued' ? undefined : TONES[lane.state];
  return <section className="lane" aria-label={SOURCE_NAMES[lane.source]()}>
    <header className="lane-head">
      <h2>{SOURCE_NAMES[lane.source]()}<span className="hint">{lane.scope}</span></h2>
      {lane.source === 'oss' && <Tag>{t('可能已被模型训练见过')}</Tag>}
      <Tag tone={tone}>{LANE_STATES[lane.state]()}</Tag>
      <span className="muted">{t('已花 {spent} / 预算 {budget}', { spent: money(lane.spentUsd), budget: money(lane.budgetUsd) })}</span>
    </header>
    {children}
  </section>;
}

// Every source of an experiment as a section, each drawn by `children` from that source's slice of the experiment.
export const Lanes = ({ experiment, children }: { experiment: LabExperiment; children: (slice: LabExperiment) => ReactNode }) =>
  <>{experiment.lanes.map(lane => <LaneSection key={lane.source} lane={lane}><div className="content">{children(sliceExperiment(experiment, lane.source))}</div></LaneSection>)}</>;
