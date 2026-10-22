import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The AudioWorklet is loaded as a module script; ES output keeps dev and build alike.
  worker: { format: 'es' },
});
