import { useEffect, useId, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { Project, ProjectImageCandidate, ProjectImageMode } from '../../shared/types';
import { t } from '../../shared/i18n';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, avatarFromFile } from '../settings/avatar-image';
import './project-image.css';

const SVG_MAX_BYTES = 100 * 1024;
const PROJECT_IMAGE_TYPES = [...AVATAR_TYPES, 'image/svg+xml', '.svg'];

export function ProjectImageDialog({ project, index, onClose }: { project: Project; index: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const scanRequest = useRef(0);
  const savingNow = useRef(false);
  const dirty = useRef(false);
  const titleId = useId(), noteId = useId(), candidatesId = useId();
  const projectMode = project.imageMode || (project.image ? 'custom' : 'auto');
  const [image, setImage] = useState(project.image || '');
  const [mode, setMode] = useState<ProjectImageMode>(projectMode);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<ProjectImageCandidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [remote, setRemote] = useState(false);
  const changed = image !== (project.image || '') || mode !== projectMode;
  const scan = async (automatic = false) => {
    const current = ++scanRequest.current;
    const choice = automatic ? ++request.current : request.current;
    if (automatic) { setProcessing(true); setError(''); }
    setScanning(true); setScanError('');
    try {
      const result = await window.agentrix.listProjectImageCandidates(project.id);
      if (current !== scanRequest.current) return;
      if (!result.ok) { setScanError(t('未能查找项目图片，请重试')); return; }
      setCandidates(result.value.candidates.slice(0, 6));
      setRemote(result.value.unavailable === 'ssh');
      if (automatic && choice === request.current) {
        dirty.current = true;
        setImage(result.value.candidates.find(candidate => candidate.source === 'icon')?.image || ''); setMode('auto');
      }
    } catch { if (current === scanRequest.current) setScanError(t('未能查找项目图片，请重试')); }
    finally {
      if (current === scanRequest.current) setScanning(false);
      if (automatic && choice === request.current) setProcessing(false);
    }
  };
  const close = () => { request.current++; scanRequest.current++; onClose(); };
  useEffect(() => {
    dialog.current?.showModal();
    void scan();
    return () => { request.current++; scanRequest.current++; };
  }, []);
  useEffect(() => {
    if (dirty.current || savingNow.current) return;
    setImage(project.image || ''); setMode(projectMode);
  }, [project.image, projectMode]);
  const choose = (next: string, nextMode: ProjectImageMode) => {
    request.current++; dirty.current = true;
    setProcessing(false); setImage(next); setMode(nextMode); setError('');
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const current = ++request.current;
    const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    if (svg && file.size > SVG_MAX_BYTES) {
      setProcessing(false); setError(t('请选择 100 KB 以内的静态 SVG 图片')); return;
    }
    if (!svg && (!AVATAR_TYPES.includes(file.type) || file.size > AVATAR_MAX_BYTES)) {
      setProcessing(false); setError(t('请选择 10 MB 以内的 PNG、JPG、WebP、GIF 或 100 KB 以内的静态 SVG 图片')); return;
    }
    setProcessing(true); setError('');
    try {
      // Keep the original SVG bytes for main's UTF-8/static-picture validation; no canvas or DOM insertion.
      const next = svg ? `data:image/svg+xml;base64,${btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join(''))}` : await avatarFromFile(file);
      if (current === request.current) { dirty.current = true; setImage(next); setMode('custom'); }
    } catch { if (current === request.current) setError(t('这张图片无法读取')); }
    finally { if (current === request.current) setProcessing(false); }
  };
  const save = async () => {
    if (savingNow.current || processing || !dirty.current || !changed) return;
    savingNow.current = true;
    setSaving(true); setError('');
    try {
      const result = await window.agentrix.setProjectImage(project.id, image, mode);
      if (!result.ok) { setError(t(result.error)); return; }
      close();
    } catch { setError(t('项目图片未能保存，请重试')); }
    finally { savingNow.current = false; setSaving(false); }
  };
  return <dialog ref={dialog} className="settings-dialog project-image-dialog" aria-labelledby={titleId} aria-describedby={noteId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!saving) close(); }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
    onClick={event => { if (event.target === event.currentTarget && !saving) close(); }}>
    <form className="dialog-content" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="dialog-heading"><h2 id={titleId}>{t('项目图片')}</h2><button type="button" className="icon-button" disabled={saving} aria-label={t('关闭项目图片')} onClick={close}><X size={18} /></button></div>
      <p className="project-image-name">{project.name}</p>
      <div className="project-image-preview" aria-label={t('项目图片预览')} data-audit-ignore>
        {image ? <img src={image} alt={t('项目图片预览')} draggable={false} data-audit-ignore /> : <span className="project-image-number">{String(index + 1).padStart(2, '0')}</span>}
      </div>
      <p id={noteId} className="project-image-note">{t('图片只在本机处理。SVG 保留矢量并完整显示；其他图片居中裁成正方形，GIF 仅使用首帧。保存后显示在卡片标题和切换提示中。')}</p>
      <div className="project-image-options">
        <input ref={input} type="file" accept={PROJECT_IMAGE_TYPES.join(',')} hidden aria-label={t('上传项目图片')} disabled={saving || processing} onChange={event => { void pick(event.target.files?.[0]); event.target.value = ''; }} />
        <button type="button" className="button secondary" disabled={saving || processing} onClick={() => input.current?.click()}>{processing ? t('正在处理图片…') : image ? t('更换图片') : t('选择图片')}</button>
        <button type="button" className="button secondary" disabled={saving || processing || scanning} onClick={() => void scan(true)}>{t('重新自动选择')}</button>
        <button type="button" className="button secondary" disabled={saving || processing || (!image && mode === 'number')} onClick={() => choose('', 'number')}>{t('恢复原样')}</button>
      </div>
      <section className="project-image-candidates" aria-labelledby={candidatesId}>
        <div className="project-image-candidates-heading"><h3 id={candidatesId}>{t('项目中的候选图片')}</h3><button type="button" className="text-button" disabled={saving || scanning} onClick={() => void scan()}>{t('重新查找')}</button></div>
        <p className="project-image-candidates-note">{t('候选只是建议。保存后固定，文件更新不会自动更换。')}</p>
        {scanning && <p className="project-image-candidates-status" role="status">{t('正在查找项目图片…')}</p>}
        {scanError && <p className="form-error" role="alert">{scanError}</p>}
        {remote ? <p className="project-image-candidates-status">{t('远程项目暂不自动查找图片，可以选择本机图片。')}</p> : candidates.length > 0 ? <div className="project-image-candidate-grid">
          {candidates.map(candidate => <button type="button" key={candidate.path} className="project-image-candidate" disabled={saving} aria-label={`${t('使用项目图片：')}${candidate.path}`} aria-pressed={image === candidate.image} title={candidate.path}
            onClick={() => choose(candidate.image, 'custom')}>
            <img src={candidate.image} alt="" draggable={false} data-audit-ignore />
            <span className="project-image-candidate-source">{t(candidate.source === 'icon' ? '图标文件' : candidate.source === 'readme' ? 'README 引用' : '项目素材')}</span>
            <span className="project-image-candidate-path">{candidate.path}</span>
          </button>)}
        </div> : !scanning && !scanError && <p className="project-image-candidates-status">{t('没有找到合适的图片，可以自行选择。')}</p>}
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="text-button" disabled={saving} onClick={close}>{t('取消')}</button><button type="submit" className="button primary" disabled={saving || processing || !dirty.current || !changed}>{saving ? t('正在保存…') : t('保存')}</button></div>
    </form>
  </dialog>;
}
