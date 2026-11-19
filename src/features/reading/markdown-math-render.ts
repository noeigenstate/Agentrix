import katex, { type KatexOptions } from 'katex';
import { mathDisplayClass, mathSourceAttribute, safeMathLength, safeStyle } from './markdown-math-sanitize.ts';

const SOURCE_LIMIT = 2048, FORMULA_LIMIT = 300, HTML_LIMIT = 1024 * 1024;
const CACHE_ENTRIES = 96, CACHE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const budgets = new WeakMap<object, { count: number; bytes: number }>();
const cache = new Map<string, { html: string; bytes: number }>();
let cachedBytes = 0;

const hiddenNodes = new Set(['phantom', 'hphantom', 'vphantom', 'smash', 'lap', 'color']);
type MathNode = { type?: string; dimension?: { number: number }; backgroundColor?: string; borderColor?: string };
// Inspect the expanded KaTeX tree so macros can't disguise a hidden span, custom paint or negative space.
const parse = (katex as typeof katex & { __parse(text: string, options: KatexOptions): unknown[] }).__parse;
function hasHiddenContent(tree: unknown[]) {
  const remaining = [...tree];
  while (remaining.length) {
    const value = remaining.pop();
    if (!value || typeof value !== 'object') continue;
    const { type, dimension, backgroundColor, borderColor } = value as MathNode;
    if (hiddenNodes.has(type ?? '') || backgroundColor || borderColor || type === 'kern' && (dimension?.number ?? 0) < 0) return true;
    for (const [key, child] of Object.entries(value)) if (key !== 'loc' && child && typeof child === 'object') remaining.push(child);
  }
  return false;
}

function safeMathMarkup(html: string) {
  for (const [, tag, attributes] of html.matchAll(/<([a-z][a-z0-9]*)\s([^>]*?)>/gi)) {
    for (const [, name, value] of attributes.matchAll(/(?:^|\s)([\w-]+)="([^"]*)"/g)) {
      if (name === 'style' ? !safeStyle(value) : !safeMathLength(tag, name, value)) return false;
    }
  }
  return true;
}

function renderKatex(text: string, displayMode: boolean) {
  const options: KatexOptions = { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxSize: 10, maxExpand: 500 };
  try {
    if (!text.trim() || hasHiddenContent(parse(text, options))) return '';
    const html = katex.renderToString(text, options);
    return !html.startsWith('<span class="katex-error"') && html.length <= HTML_LIMIT && safeMathMarkup(html) ? html : '';
  } catch {
    return '';
  }
}

function cachedMath(text: string, display: boolean) {
  const key = (display ? 'd' : 'i') + text;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.html;
  }
  const html = renderKatex(text, display);
  const bytes = encoder.encode(key).length + encoder.encode(html).length;
  if (bytes > CACHE_BYTES) return html;
  cache.set(key, { html, bytes });
  cachedBytes += bytes;
  while (cache.size > CACHE_ENTRIES || cachedBytes > CACHE_BYTES) {
    const oldest = cache.keys().next().value!;
    cachedBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
  return html;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function renderMath(parser: object, raw: string, text: string, display: boolean, closed: boolean) {
  const source = raw.trimEnd();
  const layout = display ? ' class="' + mathDisplayClass + '"' : '';
  const newline = raw.endsWith('\n') ? '\n' : '';
  const frame = (content: string) => (display ? '<span' + layout + '>' + content + '</span>' : content) + newline;
  if (!closed) return frame(escape(source));
  const fallback = () => frame('<code>' + escape(source) + '</code>');
  const budget = budgets.get(parser) ?? { count: 0, bytes: 0 };
  budgets.set(parser, budget);
  if (++budget.count > FORMULA_LIMIT || budget.bytes >= HTML_LIMIT || source.length > SOURCE_LIMIT || encoder.encode(source).length > SOURCE_LIMIT) {
    return fallback();
  }
  const html = cachedMath(text, display);
  if (!html) return fallback();
  const encoded = encodeURIComponent(source.replace(/\p{Surrogate}/gu, '\uFFFD'));
  const formula = '<span' + layout + ' ' + mathSourceAttribute + '="' + encoded + '">' + html + '</span>' + newline;
  const bytes = encoder.encode(formula).length;
  if (budget.bytes + bytes > HTML_LIMIT) return fallback();
  budget.bytes += bytes;
  return formula;
}
