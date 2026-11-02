import { useMemo } from 'react';
import createDOMPurify from 'dompurify';
import { readingMarked } from './markdown-escape';
import { QUICK, useLongMarkdown } from './useLongMarkdown';
import { currentLanguage, t } from '../../shared/i18n';
import { markReadingPaths } from './reading-paths';
import { PathText } from './PathText';

const purifier = createDOMPurify(window);
// A Markdown block the agent shows (a file's content, a draft) is laid out like the answer around it, its source a
// click away; inside it, Markdown blocks stay source. A very long one stays source too: this runs on the window's thread.
const DOCUMENT = /^(?:markdown|md|mdx)$/i, DOCUMENT_LIMIT = 20000;
// What the agent wrote, laid out as Markdown. Only plain structure survives: no raw HTML, no images (an
// answer has no business loading anything), and links open outside through the window's link handler.
function finish(parsed: string, nested = false): string {
  const html = purifier.sanitize(parsed, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr', 'br', 'em', 'strong', 's', 'del', 'input', 'kbd'],
    ALLOWED_ATTR: ['href', 'class', 'type', 'checked', 'disabled', 'start', 'align'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    // Preserve file/drive references as well as DOMPurify's usual safe links; scripts remain disallowed.
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|file|mailto|tel|callto|sms|cid|xmpp|matrix):|[a-z]:(?:[\\/]|%5c|%2f)|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  const root = document.createElement('div'); root.innerHTML = html;
  for (const box of root.querySelectorAll('input')) { box.type = 'checkbox'; box.disabled = true; }
  // Each code block gets a copy button over its top right corner.
  for (const pre of root.querySelectorAll('pre')) {
    const frame = document.createElement('div'); frame.className = 'reading-code';
    const language = pre.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1];
    const bar = document.createElement('div'); bar.className = 'reading-code-bar';
    bar.innerHTML = `<span></span><button type="button" data-copy-code>${t('复制')}</button>`;
    bar.querySelector('span')!.textContent = language || '';
    pre.replaceWith(frame); frame.append(bar, pre);
    const source = pre.textContent || '';
    if (nested || !language || !DOCUMENT.test(language) || !source.trim() || source.length > DOCUMENT_LIMIT) continue;
    const doc = document.createElement('div'); doc.className = 'reading-code-doc';
    doc.innerHTML = finish(readingMarked.parse(source) as string, true);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.dataset.codeSource = ''; toggle.textContent = t('源码');
    bar.querySelector('span')!.textContent = 'Markdown';
    bar.insertBefore(toggle, bar.querySelector('[data-copy-code]'));
    frame.classList.add('is-document'); frame.insertBefore(doc, pre);
  }
  markReadingPaths(root);
  return root.innerHTML;
}

const safely = (make: () => string) => { try { return make(); } catch { return null; } };
export function Markdown({ text, softBreaks = false }: { text: string; softBreaks?: boolean }) {
  const language = currentLanguage(), short = text.length <= QUICK;
  const quick = useMemo(() => short ? safely(() => finish(readingMarked.parse(text, { breaks: !softBreaks }) as string)) : undefined, [text, language, short, softBreaks]);
  const long = useLongMarkdown(text, short, softBreaks);
  const html = useMemo(() => short ? quick : long == null ? null : safely(() => finish(long)), [short, quick, long, language]);
  if (html == null) return <p className="reading-plain"><PathText text={text} /></p>;
  return <div className="reading-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
