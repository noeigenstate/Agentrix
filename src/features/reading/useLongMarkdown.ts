import { useEffect, useRef, useState } from 'react';
import { parseMarkdown, parsedMarkdown } from './markdown-parse.ts';

export const QUICK = 4000;

// Short answers are parsed at once. A long one is parsed in a worker (markdown-parse): until it is ready the
// previous version stays (an answer still streaming) or the text shows plain, and a parse that takes too long leaves
// it plain rather than freezing the window. One parse per answer runs at a time, always of its latest text.
export function useLongMarkdown(text: string, short: boolean, softBreaks = false) {
  const [long, setLong] = useState(() => ({ html: short ? null : parsedMarkdown(text, softBreaks) ?? null, softBreaks }));
  const target = useRef({ text, softBreaks }), pumping = useRef(false), alive = useRef(true);
  target.current = { text, softBreaks };
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (short || pumping.current) return;
    pumping.current = true;
    void (async () => {
      let value = target.current;
      while (alive.current) {
        const parsed = await parseMarkdown(value.text, value.softBreaks);
        if (!alive.current) break;
        setLong({ html: parsed, softBreaks: value.softBreaks });
        if ((target.current.text === value.text && target.current.softBreaks === value.softBreaks) || target.current.text.length <= QUICK) break;
        value = target.current;
      }
      pumping.current = false;
    })();
  }, [text, short, softBreaks]);
  return long.softBreaks === softBreaks ? long.html : null;
}
