import { Fragment } from 'react';
import { findPathCandidates } from '../terminal/terminal-links';
import { pathTooltip } from './reading-paths';

// Spans keep the exact text and normal selection/drag behavior; the reading view handles modifier clicks.
export function PathText({ text, literal = false }: { text: string; literal?: boolean }) {
  let offset = 0;
  const parts = findPathCandidates(text, literal).map(link => {
    const before = text.slice(offset, link.start); offset = link.end;
    return <Fragment key={link.start}>{before}<span data-reading-path={link.target} title={pathTooltip()}>{text.slice(link.start, link.end)}</span></Fragment>;
  });
  return <>{parts}{text.slice(offset)}</>;
}
