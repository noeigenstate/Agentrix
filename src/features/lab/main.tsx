import { createRoot } from 'react-dom/client';
import { Lab } from './Lab';
import '../../shared/styles/themes.css';
import '../../shared/styles/styles.css';
import '../../shared/styles/typography.css';
import './lab.css';
import '../../shared/platform';

const bridge = window.agentrixLab, root = document.getElementById('root')!;
// Only the lab window's preload exposes the bridge: opened anywhere else, the page says where it belongs.
if (bridge) createRoot(root).render(<Lab bridge={bridge} />);
else root.textContent = 'Open the Virtual Lab from the Agentrix menu. 请从 Agentrix 菜单打开虚拟实验室。';
