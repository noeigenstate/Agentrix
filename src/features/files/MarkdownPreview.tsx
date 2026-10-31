import { useMemo, useRef } from 'react';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import './markdown.css';
import { t } from '../../shared/i18n';
import { markdownEmphasis } from '../../shared/markdown-emphasis';

const purifier = createDOMPurify(window);
const previewMarked = new Marked(markdownEmphasis, { async: false, gfm: true });

function renderMarkdown(content: string, baseUrl: string) {
  const fragment = purifier.sanitize(previewMarked.parse(content, { async: false }), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'hr', 'br', 'em', 'strong', 's', 'del', 'input', 'sup', 'sub', 'kbd'],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'align', 'start', 'type', 'checked', 'disabled'],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, FORBID_ATTR: ['style', 'id', 'name'],
  });
  const root = document.createElement('div'); root.append(fragment);
  const base = new URL(baseUrl);
  const localUrl = (value: string) => {
    const result = new URL(value, base);
    return result.protocol === 'project-preview:' && result.hostname === base.hostname && !result.username && !result.password ? result : null;
  };
  for (const node of root.querySelectorAll('[class]')) {
    const language = node.tagName === 'CODE' ? node.className.match(/\blanguage-([\w+-]+)\b/)?.[1] : null;
    node.removeAttribute('class');
    if (language) node.className = `language-${language}`;
  }
  const slugs = new Map<string, number>();
  for (const heading of root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const slug = (heading.textContent || '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
    const count = slugs.get(slug) || 0; slugs.set(slug, count + 1);
    heading.dataset.mdAnchor = count ? `${slug}-${count}` : slug;
  }
  for (const checkbox of root.querySelectorAll('input')) { checkbox.type = 'checkbox'; checkbox.disabled = true; }
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    try {
      if (href.startsWith('#')) link.dataset.mdFragment = decodeURIComponent(href.slice(1));
      else if (/^https?:\/\//i.test(href)) { link.dataset.mdTarget = href; link.rel = 'noreferrer noopener'; }
      else {
        const url = localUrl(href);
        if (!url || !href) { link.removeAttribute('href'); continue; }
        link.dataset.mdTarget = decodeURIComponent(url.pathname.slice(1));
        link.href = url.href;
      }
    } catch { link.removeAttribute('href'); }
  }
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src') || '';
    try {
      const url = localUrl(source);
      if (/^https?:\/\//i.test(source) || /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(source)) image.src = source;
      else if (url && source) image.src = url.href;
      else image.removeAttribute('src');
    } catch { image.removeAttribute('src'); }
    image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  }
  return root.innerHTML;
}

export function MarkdownPreview({ content, baseUrl, onOpenLink }: { content: string; baseUrl: string; onOpenLink: (target: string) => void }) {
  const root = useRef<HTMLElement>(null);
  const rendered = useMemo(() => { try { return { html: renderMarkdown(content, baseUrl), error: false }; } catch { return { html: '', error: true }; } }, [content, baseUrl]);
  if (rendered.error) return <div className="file-preview-message" role="status">{t('Markdown 未能渲染，请切回编辑检查内容。')}</div>;
  return <article ref={root} className="markdown-body" aria-label={t('Markdown 预览')} tabIndex={0} onClick={event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a');
    if (!link || !root.current?.contains(link)) return;
    event.preventDefault();
    if (link.dataset.mdFragment !== undefined) [...root.current.querySelectorAll<HTMLElement>('[data-md-anchor]')].find(node => node.dataset.mdAnchor === link.dataset.mdFragment)?.scrollIntoView({ block: 'start' });
    else if (link.dataset.mdTarget) onOpenLink(link.dataset.mdTarget);
  }} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}
