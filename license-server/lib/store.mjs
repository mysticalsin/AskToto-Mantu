// Durable JSON-file storage for licenses.
//
// Design: the whole dataset is small (a handful of companies, each with a
// handful of seat activations) so we keep it fully in memory as a plain
// array and treat the JSON file as a durability layer, not a query engine.
//
// Writes are serialized through a promise-chain mutex (`writeQueue`) so two
// concurrent persist() calls can never interleave their tmp-file writes or
// renames. Because Node is single-threaded and route handlers mutate the
// in-memory array synchronously (no `await` between reading and mutating),
// there is no read-modify-write race on the data itself either — the mutex
// only needs to protect the on-disk write, which is exactly what it does.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createStore(dbPath) {
  let licenses = [];
  let loaded = false;
  let writeQueue = Promise.resolve();

  async function load() {
    try {
      const raw = await fs.readFile(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      licenses = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') {
        licenses = [];
      } else {
        throw err;
      }
    }
    loaded = true;
  }

  async function atomicWrite() {
    const dir = path.dirname(dbPath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${dbPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const payload = JSON.stringify(licenses, null, 2);
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, dbPath);
  }

  // Enqueue a persist of the *current* in-memory state. Always resolves
  // (never rejects) so a single failed write can't permanently wedge the
  // queue for future persists; the error is logged instead.
  function persist() {
    writeQueue = writeQueue.then(atomicWrite, atomicWrite).catch((err) => {
      console.error('[license-server] failed to persist licenses store:', err);
    });
    return writeQueue;
  }

  function assertLoaded() {
    if (!loaded) throw new Error('store not loaded — call load() before use');
  }

  function getAll() {
    assertLoaded();
    return licenses;
  }

  function findByKey(licenseKey) {
    return getAll().find((l) => l.licenseKey === licenseKey) || null;
  }

  function addLicense(license) {
    getAll().push(license);
    persist();
    return license;
  }

  // Resolves once every write enqueued so far has settled. Route handlers
  // don't need this (persist() is intentionally fire-and-forget so requests
  // aren't held open on disk I/O), but graceful shutdown and tests do — both
  // need to know the on-disk file reflects the latest in-memory state before
  // they tear things down.
  function idle() {
    return writeQueue;
  }

  return {
    load,
    getAll,
    findByKey,
    addLicense,
    persist,
    idle,
    get dbPath() {
      return dbPath;
    },
  };
}
