import { type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

// A wide table scrolls inside a labelled region the keyboard can focus; a hint says so only while it overflows.
// A table with a pinned first column also lands on column edges (see .sticky in dashboard.css), so no scroll position shows half a cell beside the pinned column: the region tells
// the CSS how wide the pinned column is, and, when the table overflows, makes the last column as wide as the room beside the pinned one, so the end of the scroll is a column edge too.
export function ScrollRegion({ label, tall = false, children }: { label: string; tall?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), [over, setOver] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => {
      node.style.removeProperty('--last-min');
      const overflowing = node.scrollWidth > node.clientWidth + 1, pinned = node.querySelector('.sticky th');
      setOver(overflowing);
      if (!pinned) return;
      node.style.setProperty('--pin', `${pinned.getBoundingClientRect().width}px`);
      if (overflowing) node.style.setProperty('--last-min', `${node.clientWidth - pinned.getBoundingClientRect().width}px`);
    };
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
