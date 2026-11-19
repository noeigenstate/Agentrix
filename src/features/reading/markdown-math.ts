import { renderToString } from 'katex';
import { Hooks, Lexer, type MarkedExtension, type MarkedOptions, type Token, type Tokens } from 'marked';
import { mathSourceAttribute } from './markdown-math-sanitize.ts';

const displayStart = /^( {0,3})(\\\[|\$\$(?!\$))/;
const laterDisplay = /\n {0,3}(\\\[|\$\$(?!\$))/;
const displayDollars = /(?<![\\$])\$\$(?!\$)/g;
const inlineStart = /\\[([]|(?<!\$)\$/g;
const parenMath = /^\\\(((?:[^\\\n]|\\[^\n)])*?)\\\)/;
// The negative shell check keeps joined variables such as $HOME/$USER literal.
const dollarSpan = /\$(?![\s$])(?!(?:[a-z_]\w*[:/@][^\s$]*)\$[a-z_])((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?![\d$])/i;
const dollarMath = new RegExp('^' + dollarSpan.source, dollarSpan.flags);
const dollarCandidate = new RegExp(String.raw`\$\$|` + dollarSpan.source, dollarSpan.flags);
export const mayContainMath = (text: string) => text.includes('\\(') || text.includes('\\[') || text.includes('$') && dollarCandidate.test(text);
const displayEnd = /\\[\s\S]|\$\$|^ {0,3}(?:\x60{3,}|~{3,})/gm;
const errorColor = 'reading-math-error';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type MathToken = Tokens.Generic & { text: string; display: boolean; closed: boolean };

function displayMath(source: string, start: number, opener: string, block: boolean): MathToken {
  const closer = opener === '$$' ? '$$' : '\\]';
  displayEnd.lastIndex = start;
  let match: RegExpExecArray | null;
  while ((match = displayEnd.exec(source))) {
    if (match[0] === closer && (closer !== '$$' || source[displayEnd.lastIndex] !== '$')) {
      const end = displayEnd.lastIndex;
      const trailing = block ? /^[ \t]*\n/.exec(source.slice(end))?.[0].length ?? 0 : 0;
      return { type: 'readingMath', raw: source.slice(0, end + trailing), text: source.slice(start, match.index).trim(), display: true, closed: true };
    }
    if (match[0].trimStart().startsWith('\x60') || match[0].trimStart().startsWith('~')) break;
  }
  const code = block ? -1 : source.indexOf('\x60', start);
  const raw = source.slice(0, match?.index ?? (code === -1 ? source.length : code));
  return { type: 'readingMath', raw, text: raw, display: true, closed: false };
}

function inlineMath(source: string): MathToken | undefined {
  if (source.startsWith('\\[') || source.startsWith('$$') && source[2] !== '$') {
    const token = displayMath(source, 2, source.slice(0, 2), false);
    // An unfinished bracket delimiter can also be the start of a Windows directory such as \[draft]\file.
    if (!token.closed && /^\\\[[^\]\\\n]+\][\\/]/.test(source)) return;
    return token;
  }
  const paren = source.startsWith('\\(');
  if (!paren && source[0] !== '$') return;
  const match = (paren ? parenMath : dollarMath).exec(source);
  if (!match) return;
  return { type: 'readingMath', raw: match[0], text: match[1], display: false, closed: true };
}

function renderMath(token: MathToken) {
  const { raw, text, display, closed } = token;
  const source = escape(raw.trimEnd());
  const layout = display ? ' class="reading-math-display"' : '';
  const frame = '<span' + layout + ' ' + mathSourceAttribute + '="' + source + '">';
  const end = raw.endsWith('\n') ? '</span>\n' : '</span>';
  if (!closed) return frame + source + end;
  let content = '';
  try {
    content = renderToString(text, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', maxSize: 10, maxExpand: 500, errorColor });
  } catch {
    // A formula exceeding the parser's limits still has readable source.
  }
  // With throwOnError off, unknown or untrusted commands can be rendered in the error color.
  if (!text.trim() || !content || content.includes('="color:' + errorColor) || content.includes('mathcolor="' + errorColor)) {
    return frame + '<code>' + source + '</code>' + end;
  }
  return frame + content + end;
}

export const markdownMath: MarkedExtension = {
  hooks: {
    provideLexer() {
      return (source, options) => {
        const lexer = new MathLexer(options);
        lexer.hasDisplay = /\$\$|\\\[/.test(source);
        return lexer.lex(source);
      };
    },
  },
  extensions: [
    {
      name: 'readingMath', level: 'block',
      start(source) {
        if (!(this.lexer as MathLexer).hasDisplay) return;
        const next = laterDisplay.exec(source);
        if (!next) return;
        // A paragraph can open $$ after some prose, then close it on a line of its own.
        const before = source.slice(0, next.index);
        const paragraph = before.slice(before.lastIndexOf('\n\n') + 1);
        if (next[1] === '$$' && [...paragraph.matchAll(displayDollars)].length % 2) return;
        return next.index + 1;
      },
      tokenizer(source) {
        const match = displayStart.exec(source);
        if (match) return displayMath(source, match[0].length, match[2], true);
      },
      renderer: token => renderMath(token as MathToken),
    },
    { name: 'readingMath', level: 'inline', tokenizer: inlineMath },
  ],
};

class MathLexer<ParserOutput = string, RendererOutput = string> extends Lexer<ParserOutput, RendererOutput> {
  private source = '';
  hasDisplay = false;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const hooks = new Hooks<ParserOutput, RendererOutput>();
    super({ ...options, hooks });
    hooks.emStrongMask = masked => maskMath(this.source, masked);
  }

  inlineTokens(source: string, tokens?: Token[]): Token[] {
    const previous = this.source;
    this.source = source;
    try { return super.inlineTokens(source, tokens); } finally { this.source = previous; }
  }
}

// Protect math punctuation from the emphasis scan that looks ahead of inline tokenization.
// Marked has already masked code, link destinations and escapes. Keep those spans opaque.
function maskMath(source: string, masked: string) {
  const pieces: string[] = [];
  let end = 0;
  inlineStart.lastIndex = 0;
  for (const { index = 0, 0: opener } of source.matchAll(inlineStart)) {
    if (index < end || (opener === '$' ? masked[index] !== '$' : masked.slice(index, index + 2) !== '++')) continue;
    const token = inlineMath(source.slice(index));
    if (!token) continue;
    pieces.push(masked.slice(end, index), '[' + 'a'.repeat(token.raw.length - 2) + ']');
    end = index + token.raw.length;
  }
  return end ? pieces.join('') + masked.slice(end) : masked;
}

// Only search inside the text token marked already scanned. Looking for a delimiter in the entire
// remaining paragraph before every inline token would repeatedly scan long replies.
export function splitBeforeMath(source: string, token: Tokens.Text | undefined): Tokens.Text | undefined {
  if (!token) return token;
  inlineStart.lastIndex = 1;
  for (const { index: end = 0 } of token.raw.matchAll(inlineStart)) {
    if (inlineMath(source.slice(end))) return { ...token, raw: token.raw.slice(0, end), text: token.text.slice(0, end) };
  }
  return token;
}
