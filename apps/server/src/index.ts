import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

// --port wins over $PORT: in dev, tools that launch the web app set PORT for
// it, and the room server must not grab that one too. Hosts set PORT in production.
const portFlag = process.argv.indexOf('--port');
const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : (process.env.PORT ?? 8787));
// Loopback by default; set HOST=0.0.0.0 to serve other machines (or when deployed).
const host = process.env.HOST ?? '127.0.0.1';
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const staticDir = existsSync(webDist) ? webDist : null;

const server = await startServer({ port, host, staticDir });
console.log(`Duty Cycle server on http://${host}:${server.port}`);
console.log(staticDir ? `Serving the web app from ${staticDir}` : 'No web build found; socket only (use the Vite dev server)');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
