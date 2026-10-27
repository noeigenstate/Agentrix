import { useEffect, useState, type CSSProperties } from 'react';
import { Microphone, SpinnerGap } from '@phosphor-icons/react';
import { toggleDictation, useVoice } from './voice-input';
import './voice-overlay.css';
import { t } from '../../shared/i18n';
import { shortcut } from '../shortcuts/shortcuts';
import { Select } from '../../shared/Select';

// What each recognizer is for, shown with its name and download size.
const VOICE_MODEL_KINDS: Record<string, string> = { sensevoice: '标准 · 速度快', qwen3: '高精度 · 中英混合' };
const downloadSize = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

// Settings: the offline recognizer for dictation, and how its download stands. The default downloads by itself
// after installation; a model chosen later downloads in the background while the one in use keeps working.
export function VoiceModelSetting({ choice, onChoose }: { choice: string; onChoose: (id: string) => void }) {
  const { model: voice } = useVoice();
  if (!voice?.models?.length) return null;
  const chosen = voice.models.find(model => model.id === choice) ?? voice.models[0];
  const status = chosen.phase === 'ready' ? <span className="voice-model-status is-ready" role="status">{t('已就绪')}</span>
    : chosen.phase === 'downloading' ? <span className="voice-model-status" role="status">{voice.active && voice.active !== chosen.id
      ? t('下载中 {percent}%，完成前继续使用 {model}', { percent: chosen.percent, model: voice.model }) : t('下载中 {percent}%', { percent: chosen.percent })}</span>
    : <button type="button" className="button secondary small" title={chosen.error ? t(chosen.error) : undefined} onClick={() => void window.agentrix.prepareVoice()}>{chosen.phase === 'error' ? t('重试下载') : t('下载模型')}</button>;
  return <span className="voice-model-setting">
    <Select label={t('语音识别模型')} value={chosen.id} onChange={onChoose}
      options={voice.models.map(model => ({ value: model.id, label: `${model.label} · ${t(VOICE_MODEL_KINDS[model.id] ?? '')}（${downloadSize(model.downloadBytes)}）` }))} />
    {status}
  </span>;
}

// Blue: a microphone is connected. Red: none is connected. Pulsing: recording this terminal.
export function VoiceButton({ terminalId, sessionId, name, size = 14, onError }: { terminalId: string; sessionId: string | null; name: string; size?: number; onError: (message: string) => void }) {
  const voice = useVoice();
  const recording = voice.recording === terminalId, busy = voice.busy === terminalId;
  const model = voice.model;
  const status = recording ? voice.sends ? t('正在录音 · Enter 识别并发送，再次点击只插入不发送（Esc 取消）') : t('正在录音 · Enter 或再次点击插入文字（Esc 取消）')
    : busy ? t('正在识别…')
    : voice.microphone === false ? t('未检测到麦克风')
    : model?.phase === 'downloading' ? t('麦克风已连接 · 语音模型下载中 {percent}%', { percent: model.percent })
    : model && !model.ready ? t('麦克风已连接 · 点击下载语音模型')
    : t('麦克风已连接 · 点击或按 {key} 说话', { key: shortcut('voice') });
  const tone = recording ? 'is-recording' : busy ? 'is-busy' : voice.microphone === false ? 'mic-missing' : voice.microphone ? 'mic-connected' : '';
  return <button type="button" className={`icon-button voice-button ${tone}`} title={status} aria-label={t('语音输入 {name}', { name })} aria-pressed={recording}
    style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties}
    onClick={event => { event.stopPropagation(); void toggleDictation(terminalId, sessionId, onError, name); }}>
    {busy ? <SpinnerGap className="loading-spinner" size={size} /> : <Microphone size={size} weight={recording ? 'fill' : 'regular'} />}
  </button>;
}

type Box = { left: number; top: number; width: number; height: number };

// The project card holding this terminal, tracked every frame while shown so the microphone stays
// centred on it through focus animations, window resizes and grid changes.
function useCardBox(terminalId: string | null) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!terminalId) { setBox(null); return; }
    let frame = 0;
    const track = () => {
      const card = document.querySelector(`[data-terminal-id="${CSS.escape(terminalId)}"]`)?.closest('.project-panel');
      const rect = card?.getBoundingClientRect();
      const next = rect?.width ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      setBox(current => current && next && current.left === next.left && current.top === next.top
        && current.width === next.width && current.height === next.height ? current : next);
      frame = requestAnimationFrame(track);
    };
    track();
    return () => cancelAnimationFrame(frame);
  }, [terminalId]);
  return box;
}

// The bars of one side of the sound wave, from the sphere outward: their heights in px. Short by the sphere, rising to a peak, then lower, then dots.
const BARS = [14, 22, 34, 48, 60, 46, 32, 22, 14, 8];
const DOTS = 3;
function Wave({ side }: { side: 'left' | 'right' }) {
  return <div className={`voice-wave is-${side}`}>
    {BARS.map((height, index) => <i key={index} style={{ '--bar': `${height}px`, '--delay': `${(index * .13) % 1.3}s` } as CSSProperties} />)}
    {Array.from({ length: DOTS }, (_, index) => <i key={`dot${index}`} className="is-dot" />)}
  </div>;
}
// A microphone drawn to sit in the sphere: a rounded capsule, its stand, stem and foot.
function MicrophoneGlyph() {
  return <svg viewBox="0 0 50 70" fill="none">
    <rect x="13" y="2" width="24" height="38" rx="12" fill="currentColor" />
    <path d="M5 30c0 11 9 20 20 20s20-9 20-20" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
    <path d="M25 50v13M16 65h18" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
  </svg>;
}

// Ctrl+T anywhere in the window starts dictation into the current terminal. While it records, a microphone
// sits in the middle of that terminal's project card; Enter (or Ctrl+T again) inserts the text and sends it, Esc cancels.
// The voice shortcut itself is handled with the other app shortcuts in App.
export function VoiceOverlay() {
  const voice = useVoice();
  const box = useCardBox(voice.recording || voice.busy);
  const recording = !!voice.recording;
  if (!recording && !voice.busy) return null;
  // Without a visible card (for example, while a file preview covers it) the window centre is used.
  return <div className="voice-overlay-anchor" style={box || undefined}><div className="voice-overlay" role="status" aria-live="polite" aria-label={t('语音输入')}>
    <div className={`voice-stage ${recording ? 'is-recording' : 'is-busy'}`} style={{ '--voice-level': voice.level.toFixed(2) } as CSSProperties} aria-hidden="true">
      <Wave side="left" /><Wave side="right" />
      <i className="voice-halo is-far" /><i className="voice-halo is-near" />
      <div className={`voice-orb ${recording ? 'is-recording' : 'is-busy'}`}>{recording ? <MicrophoneGlyph /> : <SpinnerGap className="loading-spinner" />}</div>
    </div>
    <b className="voice-title">{recording ? t('正在聆听…') : voice.sending ? t('正在识别并发送…') : t('正在识别…')}</b>
    {recording && <span className="voice-overlay-keys"><kbd>Enter</kbd><span>{voice.sends ? t('发送') : t('插入')}</span><i className="voice-keys-gap" /><kbd>Esc</kbd><span>{t('取消')}</span></span>}
  </div></div>;
}
