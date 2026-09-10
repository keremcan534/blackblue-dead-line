import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from file:// inside a Capacitor WebView.
  base: './',
  server: {
    host: true,
    // Honour an assigned PORT (dev-server managers, containers, CI); 5173 is
    // just the default when nothing says otherwise. Nothing here needs a fixed
    // port - there are no callbacks, webhooks or CORS origins to match.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
        },
      },
    },
  },
});
