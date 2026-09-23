import { defineConfig } from 'vite';

export default defineConfig({
  // Read the monorepo-root .env (VITE_MAPS_API_KEY lives there per README).
  envDir: '..',
  server: {
    port: 3000,
    // IPv4 loopback: this box resolves 'localhost' inconsistently (::1 vs
    // 127.0.0.1), and the tunnel + proxy need a stable address.
    host: '127.0.0.1',
    // Allow tunnel hostnames (e.g. *.trycloudflare.com) for friend playtests.
    allowedHosts: true,
    proxy: {
      // Numeric IP: some macOS/Node setups fail to resolve 'localhost' here.
      '/socket.io': 'http://127.0.0.1:3001',
    },
  },
});
