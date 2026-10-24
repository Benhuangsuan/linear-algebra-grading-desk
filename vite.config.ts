import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ignoreDevelopmentPath } from './server/watch-policy';
export default defineConfig({
  plugins: [react()],
  cacheDir: 'codex输出/codex工作区/node_modules/.vite',
  server:{watch:{ignored:path=>ignoreDevelopmentPath(process.cwd(),path)}},
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 },
});
