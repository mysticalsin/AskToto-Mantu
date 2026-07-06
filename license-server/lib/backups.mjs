// Scheduled on-server backups of the license store.
//
// scripts/backup.mjs already covers PULLING a backup from the outside, but that requires an
// operator to remember to run it. This module makes the server protect its own data: every
// BACKUP_INTERVAL_HOURS it snapshots the full store into BACKUP_DIR (default data/backups/, on
// the same Docker volume as the db) and prunes old snapshots past BACKUP_KEEP. The write goes
// through the same tmp-then-rename discipline as store.mjs so a crash mid-backup can never leave
// a truncated snapshot pretending to be a good one.
//
// Snapshot format is EXACTLY the /admin/export wrapper ({ version, exportedAt, licenses }) so any
// snapshot can be fed straight to POST /admin/restore or scripts/restore.mjs.
//
// The scheduler skips a snapshot whose license data is identical to the most recent one (no point
// burning SD-card writes on a Pi to store the same bytes again) — but an explicit "back up now"
// from the dashboard passes force=true and always writes, because an operator clicking the button
// expects a fresh file to exist afterwards.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BACKUP_FILE_RE = /^licenses-backup-[0-9TZ-]+\.json$/;

// setInterval/setTimeout delays are signed 32-bit ms in Node — anything larger overflows and the
// timer fires every 1 ms instead (verified: BACKUP_INTERVAL_HOURS=720 pegged the event loop with
// a backup attempt per millisecond). Clamp to the max representable delay (~24.8 days).
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function backupFileName(now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return `licenses-backup-${stamp}.json`;
}

export function createBackupManager(store, { dir, intervalHours = 24, keep = 30, version = '0.0.0' } = {}) {
  const backupDir = dir || path.join(path.dirname(store.dbPath), 'backups');
  // Retention below 1 would prune the snapshot just written (keep=0 deletes EVERYTHING including
  // the newest) — a backup system that keeps zero backups is a misconfiguration, not a feature.
  const retention = Math.max(1, keep);
  let timer = null;
  // Snapshot filenames embed a millisecond ISO stamp; two backups in the same millisecond (e.g.
  // two dashboard clicks) would collide and silently overwrite. Force stamps monotone-unique.
  let lastStampMs = 0;
  // Serialize backup runs the same way store.mjs serializes persists: two overlapping runs
  // (scheduler tick + dashboard button) must never interleave their list/prune steps.
  let runQueue = Promise.resolve();

  async function listFiles() {
    let names;
    try {
      names = await fs.readdir(backupDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = [];
    for (const name of names) {
      if (!BACKUP_FILE_RE.test(name)) continue;
      try {
        const stat = await fs.stat(path.join(backupDir, name));
        files.push({ name, size: stat.size, mtime: stat.mtimeMs });
      } catch (err) {
        // GET /admin/backups lists outside the run queue, so prune() can unlink a file between
        // our readdir and this stat — a vanished snapshot was just pruned, not an error.
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // The ISO stamp in the name sorts chronologically, but mtime is the operational truth
    // (and survives a filename format change) — newest first.
    files.sort((a, b) => b.mtime - a.mtime);
    return files;
  }

  async function latestLicensesJson() {
    const files = await listFiles();
    if (files.length === 0) return null;
    try {
      const raw = await fs.readFile(path.join(backupDir, files[0].name), 'utf8');
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed.licenses ?? null);
    } catch {
      // An unreadable latest backup must not block a NEW backup — quite the opposite.
      return null;
    }
  }

  async function prune() {
    const files = await listFiles();
    for (const file of files.slice(retention)) {
      try {
        await fs.unlink(path.join(backupDir, file.name));
      } catch (err) {
        console.warn('[license-server] could not prune old backup:', file.name, err.message);
      }
    }
  }

  async function writeSnapshot(nowArg) {
    const now = Math.max(nowArg, lastStampMs + 1);
    lastStampMs = now;
    await fs.mkdir(backupDir, { recursive: true });
    const name = backupFileName(now);
    const finalPath = path.join(backupDir, name);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { version, exportedAt: now, licenses: store.getAll() },
      null,
      2
    );
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, finalPath);
    return { name, count: store.getAll().length };
  }

  // Runs one backup. Returns { skipped: true } when the data is unchanged since the latest
  // snapshot (unless force), else { name, count }. Never throws — a failed backup is logged, not
  // fatal, because the server must keep serving licenses even when its backup disk is sick.
  function runBackupNow({ force = false } = {}) {
    const run = runQueue.then(
      async () => {
        const now = Date.now();
        if (!force) {
          const latest = await latestLicensesJson();
          if (latest !== null && latest === JSON.stringify(store.getAll())) {
            return { skipped: true };
          }
        }
        const result = await writeSnapshot(now);
        await prune();
        return result;
      },
      // Previous run failed — its error was already surfaced to ITS caller; start clean.
      async () => {
        const result = await writeSnapshot(Date.now());
        await prune();
        return result;
      }
    );
    // Keep the queue alive even when this run fails, so the next run isn't wedged.
    runQueue = run.catch(() => {});
    return run;
  }

  // A crash between writeFile(tmp) and rename leaves an orphaned .tmp next to the snapshots.
  // Swept at startup (before any new backup is scheduled, so nothing is mid-write).
  async function cleanupStaleTmp() {
    let names;
    try {
      names = await fs.readdir(backupDir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (!name.startsWith('licenses-backup-') || !name.endsWith('.tmp')) continue;
      try {
        await fs.unlink(path.join(backupDir, name));
      } catch {
        /* best effort */
      }
    }
  }

  function start() {
    if (timer || intervalHours <= 0) return;
    const intervalMs = Math.min(intervalHours * 60 * 60 * 1000, MAX_TIMER_DELAY_MS);
    // One backup at startup: a Pi that just came back from a power cut should immediately
    // re-establish "there is a fresh snapshot" before waiting a whole interval.
    cleanupStaleTmp()
      .catch((err) => console.warn('[license-server] stale backup tmp sweep failed:', err.message))
      .then(() => runBackupNow())
      .catch((err) => console.warn('[license-server] startup backup failed:', err.message));
    timer = setInterval(() => {
      runBackupNow()
        .then((r) => {
          if (!r.skipped) console.log(`[license-server] scheduled backup written: ${r.name} (${r.count} licenses)`);
        })
        .catch((err) => console.warn('[license-server] scheduled backup failed:', err.message));
    }, intervalMs);
    // Don't let the backup timer alone keep the process alive on shutdown.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function isSafeBackupName(name) {
    return BACKUP_FILE_RE.test(name) && path.basename(name) === name;
  }

  // Mirrors store.idle(): resolves once every backup run enqueued so far has settled, so graceful
  // shutdown can wait out an in-flight snapshot instead of killing it mid-write.
  function idle() {
    return runQueue;
  }

  return {
    start,
    stop,
    runBackupNow,
    listFiles,
    isSafeBackupName,
    idle,
    get backupDir() {
      return backupDir;
    },
  };
}
