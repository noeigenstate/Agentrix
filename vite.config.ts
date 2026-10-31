import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'local-dev-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html; },
    },
  }],
  base: './',
  // The dependency scan would otherwise glob every .html under the project, including test profiles in
  // .test-output and the promo video's compositions, and dev startup slowed as those folders grew.
  optimizeDeps: { entries: ['index.html', 'dashboard.html'] },
  server: { host: '127.0.0.1', port: 5178, strictPort: true, watch: { ignored: ['**/.test-output/**', '**/release/**', '**/promo-video/**'] } },
  // Two pages: the app and the dashboard window (agentrix://app/dashboard.html); they share the chunks they have in common.
  build: { target: 'es2022', chunkSizeWarningLimit: 750, rollupOptions: { input: { main: 'index.html', dashboard: 'dashboard.html' } } },
}));
