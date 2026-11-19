import katex, { type KatexOptions } from 'katex';
import { mathDisplayClass, mathFallbackClass, mathSourceAttribute, safeMathLength, safeStyle } from './markdown-math-sanitize.ts';

const SOURCE_LIMIT = 2048, FORMULA_LIMIT = 300, HTML_LIMIT = 1024 * 1024;
const NODE_LIMIT = 4000, SPACE_LIMIT_EM = 20, NEGATIVE_SPACE_LIMIT_EM = 1;
const CACHE_ENTRIES = 96, CACHE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const budgets = new WeakMap<object, { count: number; bytes: number }>();
const cache = new Map<string, { html: string; bytes: number }>();
let cachedBytes = 0;

const unsupportedCommands = new Set([
  'def', 'gdef', 'edef', 'xdef', 'let', 'futurelet', 'newcommand', 'renewcommand', 'providecommand',
  'mathchoice', 'TextOrMath', 'html@mathml', '@firstoftwo', '@secondoftwo', '@ifnextchar', '@ifstar',
]);
// Consume control symbols (including \\ and \%) and KaTeX's verbatim literals before testing for a comment.
const texTokens = /\\verb\*([^]).*?\1|\\verb([^*a-zA-Z]).*?\2|\\([A-Za-z@]+|[\s\S])|%/g;
const hiddenNodes = new Set(['phantom', 'hphantom', 'vphantom', 'smash', 'color']);
// Approximate KaTeX's TeX units in base-font ems for the cumulative spacing budget.
const emPerUnit: Readonly<Record<string, number>> = {
  em: 1, ex: 0.5, mu: 1 / 18, pt: 0.1, mm: 0.285, cm: 2.85, in: 7.227, bp: 0.101, pc: 1.2,
  dd: 0.108, cc: 1.29, nd: 0.107, nc: 1.29, sp: 1 / 655360, px: 0.101,
};
type MathNode = {
  type?: string; text?: string; body?: unknown; alignment?: string;
  dimension?: { number: number; unit: string }; backgroundColor?: string; borderColor?: string;
};
type ReadingKatexOptions = Omit<KatexOptions, 'macros' | 'globalGroup'>;
const katexParser = katex as typeof katex & { __parse(text: string, options: ReadingKatexOptions): unknown[] };

function safeSource(text: string) {
  for (const [token, , , command] of text.matchAll(texTokens)) {
    if (token === '%' || unsupportedCommands.has(command)) return false;
  }
  return true;
}

const glyphNodes = new Set(['atom', 'mathord', 'textord']);
function isSingleGlyphOverlay(node: MathNode) {
  const group = node.body as MathNode | undefined;
  if (group?.type !== 'ordgroup' || !Array.isArray(group.body)) return false;
  const [glyph, padding] = group.body as MathNode[];
  if (group.body.length === 1) {
    return glyphNodes.has(glyph?.type ?? '') && (glyph.text === '\\@not' || [...(glyph.text ?? '')].length === 1);
  }
  // KaTeX's \notin uses one slash with a 1mu kern to position it over the relation.
  return node.alignment === 'llap' && group.body.length === 2 && glyph?.type === 'textord' && glyph.text === '/'
    && padding?.type === 'kern' && padding.dimension?.unit === 'mu' && padding.dimension.number === 1;
}

// Inspect the expanded tree once, before KaTeX builds MathML and HTML.
function safeMathTree(tree: unknown[]) {
  const remaining = [...tree];
  let nodes = 0, space = 0, negativeSpace = 0;
  while (remaining.length) {
    const value = remaining.pop();
    if (!value || typeof value !== 'object') continue;
    const node = value as MathNode;
    const { type, text, dimension, backgroundColor, borderColor } = node;
    if (type && ++nodes > NODE_LIMIT || hiddenNodes.has(type ?? '') || backgroundColor || borderColor) return false;
    if (type === 'lap' && !isSingleGlyphOverlay(node)) return false;
    if (type === 'kern' && dimension) {
      const width = dimension.number * (emPerUnit[dimension.unit] ?? Infinity);
      if (width < 0) negativeSpace -= width;
      else space += width;
    }
    if (type === 'spacing' && text !== '\\allowbreak' && text !== '\\nobreak') space += 1 / 3;
    if (!(space <= SPACE_LIMIT_EM + 1e-9 && negativeSpace <= NEGATIVE_SPACE_LIMIT_EM + 1e-9)) return false;
    for (const [key, child] of Object.entries(value)) if (key !== 'loc' && child && typeof child === 'object') remaining.push(child);
  }
  return true;
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
  if (!text.trim() || !safeSource(text)) return '';
  const options: ReadingKatexOptions = { displayMode, throwOnError: false, trust: false, strict: 'ignore', maxSize: 10, maxExpand: 50 };
  try {
    if (!safeMathTree(katexParser.__parse(text, options))) return '';
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
  const fallback = () => frame('<code class="' + mathFallbackClass + '">' + escape(source) + '</code>');
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
