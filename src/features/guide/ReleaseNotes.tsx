import { t } from '../../shared/i18n';
import { WHATS_NEW } from './guide';
import './release-notes.css';

// This release's changes as a list: each note a marker in the list colour, its short title strong and its detail after it in the secondary ink.
export function ReleaseNotes() {
  return <ul className="release-notes">{WHATS_NEW.map(({ title, text }) => <li key={title}><b>{t(title)}</b>{t(text)}</li>)}</ul>;
}
