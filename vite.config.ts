import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420, strictPort: true,
    watch: { ignored: ['**/.tools/**', '**/artifacts/**', '**/data/**', '**/legacy/**', '**/src-tauri/**'] },
    fs: { deny: ['**/.git/**', '**/.tools/**', '**/data/**', '**/legacy/**', '**/.env*'] },
  },
  build: {
    target: ['chrome109', 'safari16'],
    outDir: 'artifacts/frontend', emptyOutDir: true,
    rollupOptions: { output: { manualChunks: { fluent: ['@fluentui/react-components'] } } },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
