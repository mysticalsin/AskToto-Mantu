import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8420;
const DB_PATH = process.env.LICENSE_DB_PATH || path.join(__dirname, 'data', 'licenses.json');

async function main() {
  const store = createStore(DB_PATH);
  await store.load();

  const app = createApp(store);

  const httpServer = app.listen(PORT, () => {
    console.log(`[license-server] listening on port ${PORT}`);
    console.log(`[license-server] data file: ${DB_PATH}`);
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      console.warn(
        '[license-server] LICENSE_ADMIN_TOKEN is not set — /admin/* routes will return 503 until it is configured.'
      );
    }
  });

  // Persist writes are fire-and-forget for request latency, so on shutdown
  // we explicitly wait for the write queue to drain before exiting —
  // otherwise a write triggered by the last request(s) could be lost.
  async function shutdown(signal) {
    console.log(`[license-server] received ${signal}, shutting down...`);
    httpServer.close(async () => {
      await store.idle();
      process.exit(0);
    });
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[license-server] fatal startup error:', err);
  process.exit(1);
});
