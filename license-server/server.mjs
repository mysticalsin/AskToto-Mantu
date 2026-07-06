import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';
import { createAuditLog } from './lib/audit.mjs';
import { createBackupManager } from './lib/backups.mjs';
import { createWebhooks } from './lib/webhooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8420;
const DB_PATH = process.env.LICENSE_DB_PATH || path.join(__dirname, 'data', 'licenses.json');

// A numeric env var where BOTH "unset" and "not a number" fall back to the default, but an
// explicit 0 is respected (BACKUP_INTERVAL_HOURS=0 disables the scheduler on purpose).
function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

async function main() {
  const store = createStore(DB_PATH);
  await store.load();
  const auditLog = createAuditLog(DB_PATH);

  const packageVersion = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

  // Server-side scheduled backups (lib/backups.mjs). Interval 0 disables the schedule but keeps
  // the manager alive so the dashboard's "Back up now" and GET /admin/backups still work.
  const backups = createBackupManager(store, {
    dir: process.env.BACKUP_DIR || undefined,
    intervalHours: numberEnv('BACKUP_INTERVAL_HOURS', 24),
    keep: numberEnv('BACKUP_KEEP', 30),
    version: packageVersion,
  });

  // Outbound webhook notifications (lib/webhooks.mjs). Inert unless LICENSE_WEBHOOK_URL is set.
  const webhooks = createWebhooks({
    url: process.env.LICENSE_WEBHOOK_URL || undefined,
    secret: process.env.LICENSE_WEBHOOK_SECRET || undefined,
    expiryAlertDays: numberEnv('WEBHOOK_EXPIRY_ALERT_DAYS', 14),
  });

  const app = createApp(store, auditLog, { webhooks, backups });

  const httpServer = app.listen(PORT, () => {
    console.log(`[license-server] listening on port ${PORT}`);
    console.log(`[license-server] data file: ${DB_PATH}`);
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      console.warn(
        '[license-server] LICENSE_ADMIN_TOKEN is not set — /admin/* routes will return 503 until it is configured.'
      );
    }
    backups.start();
    if (webhooks.enabled) {
      console.log('[license-server] webhook notifications enabled');
      webhooks.startExpirySweep(store);
    }
  });

  // Persist writes are fire-and-forget for request latency, so on shutdown
  // we explicitly wait for the write queue to drain before exiting —
  // otherwise a write triggered by the last request(s) could be lost.
  async function shutdown(signal) {
    console.log(`[license-server] received ${signal}, shutting down...`);
    backups.stop();
    webhooks.stop();
    httpServer.close(async () => {
      await store.idle();
      await auditLog.idle();
      await webhooks.idle();
      await backups.idle();
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
