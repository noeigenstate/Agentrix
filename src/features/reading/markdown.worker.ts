import { readingMarked } from './markdown-escape';

// Markdown to HTML off the window's thread: a long or pathological answer (thousands of nested emphasis marks) can
// take seconds to parse, and here it can be stopped. The HTML is sanitized by the window, which has the DOM for it.
self.onmessage = (event: MessageEvent<{ id: number; text: string; softBreaks: boolean }>) => {
  const { id, text, softBreaks } = event.data;
  let html: string | null = null;
  try { html = readingMarked.parse(text, { breaks: !softBreaks }) as string; } catch { }
  self.postMessage({ id, html });
};
