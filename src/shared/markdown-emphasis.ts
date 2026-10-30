import markedCjkFriendly from 'marked-cjk-friendly';
import { Tokenizer, type MarkedExtension } from 'marked';

// Keep multiplication readable instead of letting marked interpret the middle number as emphasis.
const productAtStart = /^\d+(?:\*\d+){2,}/;
const productTail = /^(?:\*\d+){2,}/;
const longStars = '*'.repeat(64);

export const markdownEmphasis: MarkedExtension = {
  // Only take the emphasis tokenizer: the package also changes GFM strikethrough.
  tokenizer: {
    emStrong: markedCjkFriendly().tokenizer!.emStrong,
    inlineText(source) {
      const token = Tokenizer.prototype.inlineText.call(this, source);
      if (!token || source[token.raw.length] !== '*') return token;
      let digitStart = token.raw.length;
      while (digitStart) {
        const code = token.raw.charCodeAt(digitStart - 1);
        if (code < 48 || code > 57) break;
        digitStart--;
      }
      if (digitStart === token.raw.length || !digitStart || !productTail.test(source.slice(token.raw.length))) return token;
      // Marked's text token ends before the first star. Stop before its digits so the product tokenizer runs next.
      token.raw = token.raw.slice(0, digitStart);
      token.text = token.text.slice(0, digitStart);
      return token;
    },
  },
  extensions: [
    {
      name: 'numericProduct', level: 'inline',
      tokenizer(source) {
        const raw = productAtStart.exec(source)?.[0];
        if (raw) return { type: 'text', raw, text: raw };
      },
    },
    {
      name: 'unmatchedStarRun', level: 'inline',
      tokenizer(source) {
        if (!source.startsWith(longStars)) return;
        const raw = /^\*+/.exec(source)![0];
        // No later star can close this run. Consume it once instead of rescanning every suffix.
        if (source.indexOf('*', raw.length) === -1) return { type: 'text', raw, text: raw };
      },
    },
  ],
};
