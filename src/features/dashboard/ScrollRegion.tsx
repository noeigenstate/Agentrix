import { type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

// A wide table scrolls inside a labelled region the keyboard can focus; a hint says so only while it overflows.
export function ScrollRegion({ label, tall = false, children }: { label: string; tall?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), [over, setOver] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setOver(node.scrollWidth > node.clientWidth + 1);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return <>
    <p className="scroll-hint" hidden={!over}>{t('表格较宽，可左右滚动（聚焦后按左右方向键）')}</p>
    <div ref={ref} className={tall ? 'scroll tall' : 'scroll'} role="region" aria-label={label} tabIndex={0}>{children}</div>
  </>;
}
