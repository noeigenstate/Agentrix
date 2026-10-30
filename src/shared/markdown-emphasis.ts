import markedCjkFriendly from 'marked-cjk-friendly';
import type { MarkedExtension } from 'marked';

// Keep multiplication readable instead of letting marked interpret the middle number as emphasis.
const product = /(?:^|[^\d])(\d+(?:\*\d+){2,})/;
const productAtStart = /^\d+(?:\*\d+){2,}/;
const longStars = '*'.repeat(64);

export const markdownEmphasis: MarkedExtension = {
  // Only take the emphasis tokenizer: the package also changes GFM strikethrough.
  tokenizer: { emStrong: markedCjkFriendly().tokenizer!.emStrong },
  extensions: [
    {
      name: 'numericProduct', level: 'inline',
      start(source) {
        const match = product.exec(source);
        return match ? match.index + match[0].length - match[1].length : undefined;
      },
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
