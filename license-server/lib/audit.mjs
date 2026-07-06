// Append-only JSONL audit trail for admin mutations, stored next to the
// licenses JSON file (data/audit.jsonl). Serialized through the same
// writeQueue discipline as store.mjs so concurrent appends can never
// interleave — but unlike license writes, a lost audit line must never fail
// the request it's logging, so record() always resolves and swallows its
// own errors rather than rejecting.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createAuditLog(dbPath) {
  const auditPath = path.join(path.dirname(dbPath), 'audit.jsonl');
  let writeQueue = Promise.resolve();

  async function appendLine(entry) {
    const dir = path.dirname(auditPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  // Fire-and-forget from the caller's perspective (route handlers never
  // await this) — a slow or failing disk write can never delay or fail the
  // admin response it's logging.
  function record(entry) {
    const line = { at: Date.now(), ...entry };
    writeQueue = writeQueue.then(
      () => appendLine(line),
      () => appendLine(line)
    ).catch((err) => {
      console.warn('[license-server] failed to append audit log:', err);
    });
    return writeQueue;
  }

  // How many bytes off the END of the file readLast will look at. The audit log is append-only and
  // never rotated, so over years it could grow large; reading only the tail bounds memory + latency
  // regardless of total size (a JSONL line is a few hundred bytes, so this tail always holds far more
  // than any realistic `limit`). Older entries stay on disk for offline forensics, just not served here.
  const TAIL_BYTES = 1_000_000;

  // Reads and parses the most recent lines, newest first, capped at `limit`. Only the last TAIL_BYTES
  // of the file are read. A missing file (nothing logged yet) reads as an empty log, not an error.
  async function readLast(limit) {
    let handle;
    let raw;
    try {
      handle = await fs.open(auditPath, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      raw = buf.toString('utf8');
      // A non-zero start likely lands mid-line; drop that first partial line so JSON.parse doesn't choke.
      if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    } finally {
      await handle?.close();
    }
    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // Skip a malformed line rather than fail the whole read.
      }
    }
    entries.reverse();
    return entries.slice(0, limit);
  }

  // Mirrors store.idle(): resolves once every append enqueued so far has
  // settled. Route handlers don't need this (record() is intentionally
  // fire-and-forget), but tests do, to assert on file contents deterministically.
  function idle() {
    return writeQueue;
  }

  return {
    record,
    readLast,
    idle,
    get auditPath() {
      return auditPath;
    },
  };
}
