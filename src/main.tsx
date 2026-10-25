import { createRoot } from 'react-dom/client';
import { App } from './App';
import './shared/styles/themes.css';
import './shared/styles/styles.css';
import './features/workspace/workspace.css';
import './features/files/files.css';
import './features/settings/settings.css';
import './shared/styles/typography.css';
import './shared/platform';

createRoot(document.getElementById('root')!).render(<App />);
