import { createRoot } from 'react-dom/client';
import { App } from './App';
import './shared/styles/styles.css';
import './shared/styles/glass.css';
import './shared/styles/themes.css';
import './shared/styles/polish.css';
import './shared/styles/typography.css';
import './shared/styles/interaction.css';
import './shared/styles/clarity.css';
import './shared/styles/glass-transparency.css';
import './shared/styles/desktop-glass.css';
import './features/terminal/terminal-font.css';
import './shared/platform';

document.documentElement.dataset.theme = 'catalina';
createRoot(document.getElementById('root')!).render(<App />);
