import { createRoot } from 'react-dom/client';
import { Dashboard } from './Dashboard';
import '../../shared/styles/themes.css';
import '../../shared/styles/styles.css';
import '../../shared/styles/typography.css';
import './dashboard.css';
import '../../shared/platform';

const bridge = window.agentrixDashboard, root = document.getElementById('root')!;
// Only the dashboard window's preload exposes the bridge: opened anywhere else, the page says where it belongs.
if (bridge) createRoot(root).render(<Dashboard bridge={bridge} />);
else root.textContent = 'Open the dashboard from the Agentrix menu. 请从 Agentrix 菜单打开数据看板。';
