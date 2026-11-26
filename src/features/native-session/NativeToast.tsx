import { Check, Info, X } from '@phosphor-icons/react';
import { useEffect, useRef } from 'react';
import { IconButton } from '../../shared/IconButton';
import { t } from '../../shared/i18n';
import './native-panel.css';

// A transient notice above the composer.
export function NativeToast({ text, onDismiss, onShown }: { text: string; onDismiss?: () => void; onShown?: () => void }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onShown || !node.current) return;
    let intersecting = false, reported = false;
    const reportShown = () => {
      if (reported || !intersecting || document.visibilityState !== 'visible') return;
      reported = true;
      onShown();
    };
    const observer = new IntersectionObserver(entries => {
      intersecting = (entries.at(-1)?.intersectionRatio ?? 0) > 0;
      reportShown();
    });
    observer.observe(node.current);
    document.addEventListener('visibilitychange', reportShown);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', reportShown);
    };
  }, [onShown]);
  return <div ref={node} className={onDismiss ? 'native-toast native-toast-dismissible' : 'native-toast'} role="status">
    {onDismiss ? <Info size={16} /> : <Check size={16} weight="bold" />}{text}
    {onDismiss && <IconButton label={t('关闭提示')} onClick={onDismiss}><X size={16} /></IconButton>}
  </div>;
}
