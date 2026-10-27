import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ignoreDevelopmentPath } from './server/watch-policy';
import { APP_VERSION } from './shared/version';
export default defineConfig({
  plugins: [react(),{name:'application-version',transformIndexHtml:html=>html.replace('%APP_VERSION%',APP_VERSION)}],
  cacheDir: 'codex输出/codex工作区/node_modules/.vite',
  server:{watch:{ignored:path=>ignoreDevelopmentPath(process.cwd(),path)}},
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 },
});
