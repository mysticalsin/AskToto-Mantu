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

  // Reads and parses every line, newest first, capped at `limit`. A
  // missing file (nothing logged yet) reads as an empty log, not an error.
  async function readLast(limit) {
    let raw;
    try {
      raw = await fs.readFile(auditPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
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
