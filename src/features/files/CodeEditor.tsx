import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, X } from '@phosphor-icons/react';
import type { GitDiff } from '../../shared/types';
import { findMatches, matchFrom, stepMatch, type Match } from './editor-find';
import { findConflicts, lineMarks, type Conflict } from '../git/editor-git';
export { findConflicts, resolveConflict, type Conflict } from '../git/editor-git';
import { t } from '../../shared/i18n';

// The editor is a plain textarea that never wraps, so every text line is one row of fixed height. The gutter
// (line numbers and Git change bars) and the conflict layer are drawn beside and behind it from the
// textarea's own scroll position, so they stay level with the text; only rows in view are drawn. So are the marks of
// a search (Ctrl+F), measured in the textarea's own font.
type EditorView = { top: number; left: number; height: number; line: number; padding: number; paddingLeft: number; caret: number };

function useEditorView(editor: RefObject<HTMLTextAreaElement | null>): EditorView {
  const [view, setView] = useState({ top: 0, left: 0, height: 0, line: 24, padding: 0, paddingLeft: 0 });
  const [caret, setCaret] = useState(0);
  useEffect(() => {
    const node = editor.current; if (!node) return;
    const measure = () => { const style = getComputedStyle(node); setView({ top: node.scrollTop, left: node.scrollLeft, height: node.clientHeight, line: parseFloat(style.lineHeight) || 24, padding: parseFloat(style.paddingTop) || 0, paddingLeft: parseFloat(style.paddingLeft) || 0 }); };
    const scroll = () => setView(value => ({ ...value, top: node.scrollTop, left: node.scrollLeft }));
    const select = () => { if (document.activeElement === node) setCaret(node.value.slice(0, node.selectionStart).split('\n').length - 1); };
    measure(); select();
    const resize = new ResizeObserver(measure); resize.observe(node);
    node.addEventListener('scroll', scroll); node.addEventListener('focus', select); document.addEventListener('selectionchange', select);
    return () => { resize.disconnect(); node.removeEventListener('scroll', scroll); node.removeEventListener('focus', select); document.removeEventListener('selectionchange', select); };
  }, [editor]);
  return { ...view, caret };
}

const visibleRows = (view: EditorView, count: number) => {
  const first = Math.max(0, Math.floor((view.top - view.padding) / view.line) - 2);
  return { first, last: Math.min(count, first + Math.ceil(view.height / view.line) + 4) };
};

function EditorGutter({ view, text, diff }: { view: EditorView; text: string; diff: GitDiff | null }) {
  const count = useMemo(() => { let lines = 1; for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines++; return lines; }, [text]);
  const marks = useMemo(() => lineMarks(diff, count), [diff, count]);
  const { first, last } = visibleRows(view, count);
  return <div className="editor-gutter" aria-hidden="true" style={{ width: `calc(${Math.max(2, String(count).length)}ch + 30px)` }}>
    <div style={{ transform: `translateY(${view.padding + first * view.line - view.top}px)` }}>
      {Array.from({ length: Math.max(0, last - first) }, (_, index) => {
        const line = first + index;
        return <span key={line} className={`${line === view.caret ? 'is-current' : ''} ${marks.get(line) || ''}`} style={{ height: view.line }}>{line + 1}</span>;
      })}
    </div>
  </div>;
}

// The editor shell: gutter, conflict layer and the textarea (children) mount together, so the view
// hook attaches to the textarea as soon as it exists.
export function CodeEditor({ editor, text, diff, onResolve, children }: { editor: RefObject<HTMLTextAreaElement | null>; text: string; diff: GitDiff | null; onResolve: (conflict: Conflict, choice: 'current' | 'incoming' | 'both') => void; children: ReactNode }) {
  const view = useEditorView(editor);
  const conflicts = useMemo(() => findConflicts(text), [text]);
  const find = useEditorFind(editor, text);
  return <div className="file-editor">
    <EditorGutter view={view} text={text} diff={diff} />
    <div className="editor-surface">{find.matches.length > 0 && <FindLayer view={view} text={text} matches={find.matches} current={find.index} editor={editor} />}
      {conflicts.length > 0 && <ConflictLayer view={view} conflicts={conflicts} onResolve={onResolve} />}{children}{find.bar}</div>
  </div>;
}

// The width of text as the textarea draws it: a hidden copy of its text styles beside it lays the text out with the
// same fonts (Chinese ones included), spacing and tab stops.
const MIRRORED = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariantLigatures', 'fontFeatureSettings', 'fontKerning', 'letterSpacing', 'wordSpacing', 'tabSize', 'textRendering'] as const;
const mirrors = new WeakMap<HTMLTextAreaElement, HTMLSpanElement>();
function measurer(node: HTMLTextAreaElement) {
  let mirror = mirrors.get(node);
  if (!mirror?.isConnected) {
    mirror = document.createElement('span'); mirror.className = 'editor-measure'; mirror.setAttribute('aria-hidden', 'true');
    node.parentElement?.append(mirror); mirrors.set(node, mirror);
  }
  const style = getComputedStyle(node), copy = mirror;
  for (const name of MIRRORED) copy.style[name] = style[name];
  return (value: string) => { copy.textContent = value; return copy.getBoundingClientRect().width; };
}
const lineStarts = (text: string) => { const starts = [0]; for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1); return starts; };
const rowOf = (starts: readonly number[], position: number) => { let low = 0, high = starts.length - 1; while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= position) low = middle; else high = middle - 1; } return low; };

// Ctrl+F: a bar over the editor's top right finds the words in the file (Enter the next, Shift+Enter the one before,
// F3 too from the text); the match shown is selected in the text and scrolled into view, and Escape returns there.
function useEditorFind(editor: RefObject<HTMLTextAreaElement | null>, text: string) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [matchCase, setMatchCase] = useState(false), [index, setIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null), from = useRef(0);
  const matches = useMemo(() => open ? findMatches(text, query, matchCase) : [], [open, text, query, matchCase]);
  useEffect(() => { setIndex(matchFrom(matches, from.current)); }, [matches]);
  useEffect(() => {
    const node = editor.current, match = matches[index];
    if (!open || !node || !match) return;
    node.setSelectionRange(match.start, match.end);
    const style = getComputedStyle(node), line = parseFloat(style.lineHeight) || 24, y = (parseFloat(style.paddingTop) || 0) + rowOf(lineStarts(text), match.start) * line;
    if (y < node.scrollTop || y + line > node.scrollTop + node.clientHeight) node.scrollTop = y - node.clientHeight / 2;
    const x = (parseFloat(style.paddingLeft) || 0) + measurer(node)(text.slice(text.lastIndexOf('\n', match.start - 1) + 1, match.start));
    if (x < node.scrollLeft + 24 || x > node.scrollLeft + node.clientWidth - 80) node.scrollLeft = Math.max(0, x - node.clientWidth / 3);
  }, [index, matches]);
  const step = (direction: 1 | -1) => { const next = stepMatch(index, matches.length, direction); if (next >= 0) { from.current = matches[next].start; setIndex(next); } };
  const show = () => {
    const node = editor.current;
    if (node) {
      const selected = node.value.slice(node.selectionStart, node.selectionEnd);
      if (selected && !selected.includes('\n') && selected.length <= 200) setQuery(selected);
      from.current = node.selectionStart;
    }
    setOpen(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
  };
  const close = () => { setOpen(false); editor.current?.focus(); };
  useEffect(() => {
    const node = editor.current; if (!node) return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); show(); }
      else if (open && event.key === 'F3') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      else if (open && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    };
    node.addEventListener('keydown', key);
    return () => node.removeEventListener('keydown', key);
  });
  const keys = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'F3') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); input.current?.select(); }
  };
  const count = matches.length ? `${index + 1}/${matches.length}${matches.length >= 10000 ? '+' : ''}` : query ? t('无结果') : '';
  const bar = open ? <div className="editor-find" role="search" aria-label={t('查找')}>
    <input ref={input} value={query} placeholder={t('查找')} aria-label={t('查找')} spellCheck={false} onChange={event => { from.current = editor.current?.selectionStart ?? 0; setQuery(event.target.value); }} onKeyDown={keys} />
    <span className="editor-find-count" aria-live="polite">{count}</span>
    <button type="button" className="icon-button editor-find-case" aria-pressed={matchCase} title={t('区分大小写')} aria-label={t('区分大小写')} onClick={() => setMatchCase(value => !value)}>Aa</button>
    <button type="button" className="icon-button" disabled={!matches.length} title={t('上一个（Shift+Enter）')} aria-label={t('上一个')} onClick={() => step(-1)}><ArrowUp size={14} /></button>
    <button type="button" className="icon-button" disabled={!matches.length} title={t('下一个（Enter）')} aria-label={t('下一个')} onClick={() => step(1)}><ArrowDown size={14} /></button>
    <button type="button" className="icon-button" title={t('关闭查找（Esc）')} aria-label={t('关闭查找')} onClick={close}><X size={14} /></button>
  </div> : null;
  return { matches, index, bar };
}

// Every match in view marked behind the text, the one shown brighter.
function FindLayer({ view, text, matches, current, editor }: { view: EditorView; text: string; matches: readonly Match[]; current: number; editor: RefObject<HTMLTextAreaElement | null> }) {
  const starts = useMemo(() => lineStarts(text), [text]);
  const node = editor.current;
  if (!node) return null;
  const width = measurer(node);
  const { first, last } = visibleRows(view, starts.length);
  const from = starts[first] ?? 0, to = last < starts.length ? starts[last] : text.length + 1;
  let low = 0, high = matches.length;
  while (low < high) { const middle = (low + high) >> 1; if (matches[middle].start < from) low = middle + 1; else high = middle; }
  const bands: ReactNode[] = [];
  for (let at = low; at < matches.length && matches[at].start < to && bands.length < 400; at++) {
    const match = matches[at], row = rowOf(starts, match.start), lineStart = starts[row];
    const left = width(text.slice(lineStart, match.start)), right = width(text.slice(lineStart, match.end));
    bands.push(<i key={match.start} className={at === current ? 'is-current' : ''} style={{ left: view.paddingLeft + left - view.left, top: view.padding + row * view.line - view.top, width: Math.max(2, right - left), height: view.line }} />);
  }
  return <div className="find-bands" aria-hidden="true">{bands}</div>;
}

function ConflictLayer({ view, conflicts, onResolve }: { view: EditorView; conflicts: Conflict[]; onResolve: (conflict: Conflict, choice: 'current' | 'incoming' | 'both') => void }) {
  const top = (line: number) => view.padding + line * view.line - view.top;
  const shown = conflicts.filter(conflict => top(conflict.end + 1) > -view.line && top(conflict.start) < view.height + view.line);
  const band = (from: number, to: number, className: string) => <i className={className} style={{ top: top(from), height: Math.max(0, to - from) * view.line }} />;
  return <>
    <div className="conflict-bands" aria-hidden="true">{shown.map(conflict => <span key={conflict.start}>
      {band(conflict.start, conflict.start + 1, 'conflict-marker current')}
      {band(conflict.start + 1, conflict.base ?? conflict.middle, 'conflict-current')}
      {conflict.base !== null && band(conflict.base, conflict.middle, 'conflict-base')}
      {band(conflict.middle, conflict.middle + 1, 'conflict-marker')}
      {band(conflict.middle + 1, conflict.end, 'conflict-incoming')}
      {band(conflict.end, conflict.end + 1, 'conflict-marker incoming')}
    </span>)}</div>
    <div className="conflict-actions">{shown.map(conflict => <div key={conflict.start} role="group" aria-label={t('合并冲突（第 {line} 行）', { line: conflict.start + 1 })} style={{ top: top(conflict.start), height: view.line }}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => onResolve(conflict, 'current')}>{t('保留当前更改')}</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => onResolve(conflict, 'incoming')}>{t('保留传入的更改')}</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => onResolve(conflict, 'both')}>{t('保留双方')}</button>
    </div>)}</div>
  </>;
}
