// The key above the charts: one chip per model with its mark and run count. Picking one dims the others in every chart and table;
// picking it again, or another, moves or lifts the highlight. Colour is never the only cue: the chip carries the mark and the name.
import type { DashboardModelRow } from '../../shared/dashboard-types';
import { t } from '../../shared/i18n';
import { Marker } from './Charts';
import { modelLabel, modelShort } from './format';
import { useModels } from './model-look';

export function ModelKey({ models, onFocus }: { models: DashboardModelRow[]; onFocus(model: string | null): void }) {
  const { focus } = useModels();
  return <div className="keybar" role="group" aria-label={t('模型图例，点击突出一个模型')}>
    <span className="cap">{t('模型 · 一个颜色一个形状，所有图表一致')}</span>
    {models.map(row => <button key={row.model} type="button" className="button" aria-pressed={focus === row.model} title={modelLabel(row.model)}
      onClick={() => onFocus(focus === row.model ? null : row.model)}>
      <Marker model={row.model} />{modelShort(row.model)}<small>{row.runs}</small>
    </button>)}
  </div>;
}
