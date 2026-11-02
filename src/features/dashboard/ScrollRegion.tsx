import { type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';

// A column the region cuts through, under the pinned column or at the right edge, is hidden until scrolling brings it whole into view (.is-cut in dashboard.css): a value is never
// shown half, with its unit or its last digit gone. Run on every scroll and resize, on the pinned tables only, which land on column edges.
export function hideCutColumns(node: HTMLElement) {
  const heads = Array.from(node.querySelectorAll('.sticky th')), box = node.getBoundingClientRect();
  const from = box.left + (heads[0]?.getBoundingClientRect().width ?? 0), to = box.left + node.clientWidth;
  const cut = heads.map((head, index) => {
    const { left, right } = head.getBoundingClientRect();
    return index > 0 && (left < from - 0.5 || right > to + 0.5);
  });
  node.querySelectorAll('.sticky tr').forEach(row => Array.from(row.children).forEach((cell, index) => cell.classList.toggle('is-cut', cut[index] ?? false)));
}

// A wide table scrolls inside a labelled region the keyboard can focus; a hint says so only while it overflows.
// A table with a pinned first column also lands on column edges (see .sticky in dashboard.css), so no scroll position shows half a cell beside the pinned column: the region tells
// the CSS how wide the pinned column is, and, when the table overflows, makes the last column as wide as the room beside the pinned one, so the end of the scroll is a column edge too.
// The room is the region's exact width, not clientWidth: that is a whole number, and on a scaled display the region is often a fraction short of it, which left the last column 1px under the pin.
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
      const pin = pinned.getBoundingClientRect().width, room = node.getBoundingClientRect().width - (node.offsetWidth - node.clientWidth);
      node.style.setProperty('--pin', `${pin}px`);
      if (overflowing) node.style.setProperty('--last-min', `${room - pin}px`);
      hideCutColumns(node);
    };
    read();
    const onScroll = () => hideCutColumns(node);
    node.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { observer.disconnect(); node.removeEventListener('scroll', onScroll); };
  }, []);
  return <>
    <p className="scroll-hint" hidden={!over}>{t('表格较宽，可左右滚动（聚焦后按左右方向键）')}</p>
    <div ref={ref} className={tall ? 'scroll tall' : 'scroll'} role="region" aria-label={label} tabIndex={0}>{children}</div>
  </>;
}
