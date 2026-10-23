import { defineConfig } from 'vite';

export default defineConfig({
  // three.js and the postprocessing stack load as one lazy chunk behind the page shell.
  build: { chunkSizeWarningLimit: 800 },
});
