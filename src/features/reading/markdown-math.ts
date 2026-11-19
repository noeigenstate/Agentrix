import { Hooks, Lexer, type MarkedExtension, type MarkedOptions, type Token, type Tokens } from 'marked';
import { renderMath } from './markdown-math-render.ts';

const displayStart = /^( {0,3})(\\\[|\$\$(?!\$))/;
const laterDisplay = /\n {0,3}(\\\[|\$\$(?!\$))/;
const displayDollars = /(?<![\\$])\$\$(?!\$)/g;
const inlineStart = /\\[([]|\\[\s\S]|(?<!\$)\$/g;
const parenMath = /^\\\(((?:[^\\\n]|\\[^\n)])*?)\\\)/;
// The negative shell check keeps joined variables such as $HOME/$USER literal.
const dollarSpan = /\$(?![\s$])(?!(?:[a-z_]\w*[:/@][^\s$]*)\$[a-z_])((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?![\d$])/i;
const dollarMath = new RegExp('^' + dollarSpan.source, dollarSpan.flags);
export function mayContainMath(text: string) {
  if (text.includes('\\(') || text.includes('\\[') || text.includes('$$')) return true;
  if (!text.includes('$')) return false;
  // Consume backslash escapes first. A dollar regex never starts at an escaped dollar.
  for (const match of text.matchAll(inlineStart)) {
    if (match[0] === '$' && dollarMath.test(text.slice(match.index))) return true;
  }
  return false;
}
const displayEnd = /\\[\s\S]|\$\$|^ {0,3}(?:\x60{3,}|~{3,})/gm;

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
      renderer(token) {
        const { raw, text, display, closed } = token as MathToken;
        return renderMath(this.parser, raw, text, display, closed);
      },
    },
    {
      name: 'readingMath', level: 'inline',
      start(source) { return (this.lexer as MathLexer).nextMath(source.length); },
      tokenizer: inlineMath,
    },
  ],
};

class MathLexer<ParserOutput = string, RendererOutput = string> extends Lexer<ParserOutput, RendererOutput> {
  private inlineRun = { source: '', starts: [] as number[], cursor: 0 };
  hasDisplay = false;

  constructor(options?: MarkedOptions<ParserOutput, RendererOutput>) {
    const hooks = new Hooks<ParserOutput, RendererOutput>();
    super({ ...options, hooks });
    hooks.emStrongMask = masked => maskMath(this.inlineRun.source, masked, this.inlineRun.starts);
  }

  inlineTokens(source: string, tokens?: Token[]): Token[] {
    const previous = this.inlineRun;
    this.inlineRun = { source, starts: [], cursor: 0 };
    try { return super.inlineTokens(source, tokens); } finally { this.inlineRun = previous; }
  }

  nextMath(remaining: number) {
    const run = this.inlineRun;
    const offset = run.source.length - remaining;
    while (run.starts[run.cursor] < offset) run.cursor++;
    const next = run.starts[run.cursor];
    if (next !== undefined) return next - offset;
  }
}

// Protect math punctuation from the emphasis scan that looks ahead of inline tokenization.
// Marked has already masked code, link destinations and escapes. Keep those spans opaque.
function maskMath(source: string, masked: string, starts: number[]) {
  const pieces: string[] = [];
  let end = 0;
  for (const { index = 0, 0: opener } of source.matchAll(inlineStart)) {
    if (opener !== '$' && opener !== '\\(' && opener !== '\\[') continue;
    if (index < end || (opener === '$' ? masked[index] !== '$' : masked.slice(index, index + 2) !== '++')) continue;
    const token = inlineMath(source.slice(index));
    if (!token) continue;
    starts.push(index);
    pieces.push(masked.slice(end, index), '[' + 'a'.repeat(token.raw.length - 2) + ']');
    end = index + token.raw.length;
  }
  return end ? pieces.join('') + masked.slice(end) : masked;
}
