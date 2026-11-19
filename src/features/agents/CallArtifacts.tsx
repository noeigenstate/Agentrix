import { useEffect, useState } from 'react';
import type { CallFileResult } from '../../shared/types';
import { t } from '../../shared/i18n';
import { useSplits } from './subagent-splits.ts';

const FILE_LABELS = { brief: '简报', log: '日志' } as const;
const FILE_ERRORS = { unavailable: '文件不可用', missing: '文件尚未写入', 'too-large': '文件过大', refused: '无法读取文件' } as const;
type CallIdentity = { terminalId: string; callId: string };
type ArtifactKind = keyof typeof FILE_LABELS;

function ArtifactPreview({ terminalId, callId, kind }: CallIdentity & { kind: ArtifactKind }) {
  const [result, setResult] = useState<CallFileResult | null>(null);
  useEffect(() => {
    let active = true;
    const read = window.agentrix?.callFile?.(terminalId, callId, kind);
    if (read) void read.then(value => { if (active) setResult(value); }, () => { if (active) setResult({ ok: false, code: 'refused' }); });
    else setResult({ ok: false, code: 'unavailable' });
    return () => { active = false; };
  }, [terminalId, callId, kind]);
  return result?.ok ? <><pre>{result.text}</pre>{result.truncated && <small>{t('仅显示文件的前 256 KB')}</small>}</>
    : <p role="status">{t(result ? FILE_ERRORS[result.code] : '正在读取…')}</p>;
}

function ArtifactDisclosure({ terminalId, callId, kind }: CallIdentity & { kind: ArtifactKind }) {
  const [open, setOpen] = useState(false);
  return <details className="subagent-artifact" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t(FILE_LABELS[kind])}</summary>
    {open && <ArtifactPreview terminalId={terminalId} callId={callId} kind={kind} />}
  </details>;
}

export function CallArtifacts({ terminalId, callId }: CallIdentity) {
  const artifacts = useSplits().find(split => split.terminalId === terminalId && split.callId === callId)?.artifacts;
  if (!artifacts) return null;
  return <div className="subagent-artifacts" key={JSON.stringify([terminalId, callId])}>
    {artifacts.brief && <ArtifactDisclosure terminalId={terminalId} callId={callId} kind="brief" />}
    {artifacts.log && <ArtifactDisclosure terminalId={terminalId} callId={callId} kind="log" />}
  </div>;
}
