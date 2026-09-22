import { defineConfig } from 'vite';

export default defineConfig({
  // Read the monorepo-root .env (VITE_MAPS_API_KEY lives there per README).
  envDir: '..',
  server: {
    port: 3000,
    proxy: {
      // Numeric IP: some macOS/Node setups fail to resolve 'localhost' here.
      '/socket.io': 'http://127.0.0.1:3001',
    },
  },
});
