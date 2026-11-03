import { t } from '../../shared/i18n';
import { WHATS_NEW } from './guide';
import './release-notes.css';

function NoteList({ notes }: { notes: typeof WHATS_NEW }) {
  return <ul className="release-notes">{notes.map(({ title, text }) => <li key={title}><b>{t(title)}</b>{t(text)}</li>)}</ul>;
}

// This release's changes as a list: each note a marker in the list colour, its short title strong and its detail after it in the secondary ink.
// What this beta adds sits under its own small heading, the older notes of the release under another; with only one kind there is a single list and no headings.
export function ReleaseNotes() {
  const added = WHATS_NEW.filter(note => note.group === 'new'), earlier = WHATS_NEW.filter(note => note.group !== 'new');
  if (!added.length || !earlier.length) return <NoteList notes={WHATS_NEW} />;
  return <div className="release-groups">
    <section><h4>{t('本次测试版新增')}</h4><NoteList notes={added} /></section>
    <section><h4>{t('1.3.26 的其他更新')}</h4><NoteList notes={earlier} /></section>
  </div>;
}
