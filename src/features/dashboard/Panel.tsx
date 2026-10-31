import type { ReactNode } from 'react';

// One card of the page: a 14px title, a 12px hint beside it, then its content.
export function Panel({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <section className="panel"><h2>{title}{hint && <span className="hint">{hint}</span>}</h2>{children}</section>;
}

// What a panel says when the records give it nothing to show.
export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
