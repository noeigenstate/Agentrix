import { useEffect, useRef, useState } from 'react';
import type { AgentProvider } from '../../shared/agent-events';
import type { NativeModelOptions, NativeModelOptionsPatch } from '../../shared/types';
import { t } from '../../shared/i18n';
import { modelLabel } from '../../shared/model-name.ts';
import { Select } from '../../shared/Select';
import { AgentMark } from '../reading/feed-parts';
import { nativeBridge } from './native-bridge.ts';
import { compact, grouped, percentWords, share } from './native-panel.ts';
import type { NativeModel } from './native-model.ts';
import { reasonWords } from './native-words.ts';

export function NativeModelControls({ terminalId, sessionId, kind, agent, idle, context, routingRevision, busy, onBusy, onError }: {
  terminalId: string; sessionId: string; kind: AgentProvider; agent: string; idle: boolean; context: NativeModel['context'];
  routingRevision: number | null; busy: boolean; onBusy(value: boolean): void; onError(message: string | null): void;
}) {
  const [options, setOptions] = useState<NativeModelOptions | null>(null);
  const pending = useRef(false), revision = useRef(0);
  useEffect(() => {
    const bridge = nativeBridge();
    if (!bridge?.modelOptions || !idle || busy) return;
    const mine = ++revision.current;
    void bridge.modelOptions(terminalId, sessionId).then(result => {
      if (mine !== revision.current) return;
      if (result.ok) setOptions(result.value);
      else onError(reasonWords(result.error) ?? t('无法读取会话模型选项。'));
    }, () => { if (mine === revision.current) onError(t('无法读取会话模型选项。')); });
    return () => { revision.current++; };
  }, [terminalId, sessionId, idle, busy, routingRevision]);

  const update = async (patch: NativeModelOptionsPatch) => {
    const bridge = nativeBridge();
    if (!bridge?.modelOptions || !idle || pending.current) return;
    pending.current = true;
    revision.current++;
    onBusy(true); onError(null);
    try {
      const result = await bridge.modelOptions(terminalId, sessionId, patch);
      if (result.ok) setOptions(result.value);
      else onError(reasonWords(result.error) ?? t('无法切换会话模型或强度。'));
    } catch { onError(t('无法切换会话模型或强度。')); }
    finally { pending.current = false; onBusy(false); }
  };

  const percent = context && share(context.used, context.size);
  const usage = context && t('上下文 {used} / {total}', { used: grouped(context.used), total: grouped(context.size) });
  const models = options?.models.map(({ value }) => ({ value, label: modelLabel([], value, true) })) ?? [];
  const efforts = options?.efforts ?? [];
  const disabled = !idle || busy;
  return <div className="native-model-controls">
    <span className="native-model-agent"><AgentMark agent={kind} />{agent}</span>
    {models.length > 0 && <Select label={t('模型')} value={options?.model ?? ''} disabled={disabled} options={models} onChange={model => void update({ model })} />}
    {efforts.length > 0 && <Select label={t('强度')} value={options?.effort ?? ''} disabled={disabled} options={efforts} onChange={effort => void update({ effort })} />}
    {context && <span className="native-context-usage" title={usage ?? undefined}>
      {t('上下文 {used} / {total}', { used: compact(context.used), total: compact(context.size) })}{percent !== null && ` · ${percentWords(percent)}`}
    </span>}
  </div>;
}
