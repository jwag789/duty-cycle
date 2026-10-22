import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The AudioWorklet is loaded as a module script; ES output keeps dev and build alike.
  worker: { format: 'es' },
  server: {
    // The room server (apps/server) runs on 8787. 127.0.0.1, not localhost, so
    // Node doesn't try IPv6 first and miss a server bound to IPv4.
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
});
