import { useLayoutEffect, useRef, useState } from 'react';
import { TimelineStep } from './Timeline';
import type { PendingPrompt } from './pending-prompts';
import { withPictures } from './pasted-pictures';
import { showPopup } from '../files/file-popup';
import { t } from '../../shared/i18n';
import { UserAvatar } from '../../shared/UserAvatar';
import { Image as ImageIcon, X } from '@phosphor-icons/react';
import './pending-prompts.css';

// What the user wrote, folded to three lines when it runs longer (a pasted log, a long brief), with a button to read
// all of it. Whether it runs longer is measured on the laid-out text, so a long line that wraps counts too.

export function UserText({ text }: { text: string }) {
  const node = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false), [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = node.current; if (!element) return;
    const measure = () => { if (!element.classList.contains('is-folded')) return; setLong(element.scrollHeight > element.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text, open]);
  return <>
    <p ref={node} className={open ? undefined : 'is-folded'}>{text}</p>
    {(long || open) && <button type="button" className="text-button reading-user-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('收起') : t('展开全文')}</button>}
  </>;
}

// The pictures a message carried, small, under its text.
// A message's words and pictures; the path of a picture pasted for an SSH project shows as that picture.
export function UserMessage({ text, images }: { text: string; images?: readonly string[] }) {
  const shown = withPictures(text, images);
  return <>{shown.text && <UserText text={shown.text} />}{shown.images.length > 0 && <UserImages images={shown.images} />}</>;
}

// A click shows the picture larger, in the popup over the conversation.
export function UserImages({ images, numbers, onRemove }: { images: readonly string[]; numbers?: readonly number[]; onRemove?: (index: number) => void }) {
  return <div className="reading-user-images">{images.map((src, index) => {
    const name = t('附加的图片 {n}', { n: numbers?.[index] ?? index + 1 });
    return <span key={index} className="reading-user-image"><button type="button" className="reading-user-image-zoom" disabled={!src} title={t('点击放大')} aria-label={t('放大 {name}', { name })} onClick={() => showPopup({ kind: 'picture', src, path: name })}>
      {src ? <img src={src} alt={name} loading="lazy" decoding="async" /> : <ImageIcon size={24} aria-label={name} />}</button>
      {onRemove && <button type="button" className="reading-user-image-remove" title={t('移除这张图片')} aria-label={t('移除这张图片')} onClick={() => onRemove(index)}><X size={12} weight="bold" /></button>}</span>;
  })}</div>;
}

// Messages sent from here that no record has shown yet. One the agent holds in its queue says it waits there for the
// step in hand to finish; one the agent never took, even after it was sent again, says so and offers to send it once
// more or drop it.
export function PendingPromptEntries({ prompts, queued = () => false, undelivered = () => false, onResend, onDiscard }: {
  prompts: readonly PendingPrompt[]; queued?: (prompt: PendingPrompt) => boolean; undelivered?: (prompt: PendingPrompt) => boolean; onResend?: (prompt: PendingPrompt) => void; onDiscard?: (prompt: PendingPrompt) => void;
}) {
  return prompts.map(prompt => {
    const lost = undelivered(prompt), waiting = queued(prompt);
    return <TimelineStep key={prompt.id} at={prompt.at} kind="user" who={t('你')} mark={<UserAvatar />}><div className={`reading-user reading-pending${prompt.sending && !waiting ? ' is-sending' : ''}${waiting ? ' is-queued' : ''}${lost ? ' is-undelivered' : ''}`}>
      <UserMessage text={prompt.text} images={prompt.images} />
      {waiting ? <small role="status">{t('已送达，排队中：当前这一步完成后它就会读到')}</small> : prompt.sending && <small role="status">{t('发送中')}</small>}
      {lost && <div className="reading-undelivered" role="alert"><small>{t('未送达：助手没有收到这条消息')}</small>
        <button type="button" className="text-button" onClick={() => onResend?.(prompt)}>{t('重新发送')}</button>
        <button type="button" className="text-button" onClick={() => onDiscard?.(prompt)}>{t('移除')}</button></div>}
    </div></TimelineStep>;
  });
}
