// A call's model in words. Before a dispatched worker reports its model: the one the lead asked for, marked unconfirmed, or 模型未确认.
// The dashboard's stored placeholder 'unreported' reads the same way.
import { t } from './i18n';
import { modelName } from './model-name';

export const callModelName = ({ model, modelUnconfirmed }: { model: string | null; modelUnconfirmed?: boolean }) =>
  model === null || model === 'unreported' ? t('模型未确认') : modelUnconfirmed ? t('{model}（未确认）', { model: modelName(model) }) : modelName(model);
