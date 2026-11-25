import { t } from '../../shared/i18n';
import { WHATS_NEW } from './guide';
import './release-notes.css';

function NoteList({ notes }: { notes: typeof WHATS_NEW }) {
  const ordered = [...notes].sort((a, b) => Number(!!b.highlight) - Number(!!a.highlight));
  return <ul className="release-notes">{ordered.map(({ title, text, highlight }) => (
    <li key={title} className={highlight ? 'release-note-highlight' : undefined}>
      {highlight && <span className="release-note-sr-only">{t('重要：')}</span>}
      <b>{t(title)}</b>{t(text)}
    </li>
  ))}</ul>;
}

// This release's changes as a list: each note a marker in the list colour, its short title strong and its detail after it in the secondary ink.
// What this beta adds sits under its own small heading, the older notes of the release under another; with only one kind there is a single list and no headings.
export function ReleaseNotes() {
  const added = WHATS_NEW.filter(note => note.group === 'new'), earlier = WHATS_NEW.filter(note => note.group !== 'new');
  if (!added.length || !earlier.length) return <NoteList notes={WHATS_NEW} />;
  return <div className="release-groups">
    <section><h4>{t('本次测试版新增')}</h4><NoteList notes={added} /></section>
    <section><h4>{t('此前测试版的更新')}</h4><NoteList notes={earlier} /></section>
  </div>;
}
