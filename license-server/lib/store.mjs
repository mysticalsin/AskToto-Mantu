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

  // A minimally-valid license record. A partially-corrupt data file (valid JSON, but an entry missing
  // its key or activations) must not be served as-is: a license with no key can never be found/activated
  // and an activations field that isn't an array crashes seat math. We drop such entries loudly rather
  // than silently serve garbage. (A file that isn't parseable JSON at all still throws below = fail loud,
  // never start empty — starting empty would silently un-license every real customer.)
  function isValidLicense(l) {
    return (
      l &&
      typeof l === 'object' &&
      typeof l.licenseKey === 'string' &&
      l.licenseKey.length > 0 &&
      typeof l.seatCap === 'number' &&
      Array.isArray(l.activations)
    );
  }

  async function load() {
    try {
      const raw = await fs.readFile(dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      const valid = arr.filter(isValidLicense);
      if (valid.length !== arr.length) {
        console.warn(
          `[license-server] licenses store had ${arr.length - valid.length} malformed record(s); they were dropped on load. Check ${dbPath}.`
        );
      }
      licenses = valid;
    } catch (err) {
      if (err.code === 'ENOENT') {
        licenses = [];
      } else {
        // Unparseable file (disk corruption, truncated write): fail loud. Do NOT start with an empty
        // store, which would silently un-license every customer until someone noticed.
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

  function removeLicense(licenseKey) {
    const all = getAll();
    const idx = all.findIndex((l) => l.licenseKey === licenseKey);
    if (idx === -1) return false;
    all.splice(idx, 1);
    persist();
    return true;
  }

  // Replace the ENTIRE dataset (used by /admin/restore). Rejects a payload that isn't a clean array of
  // valid licenses BEFORE touching anything, so a bad restore can't wipe or half-apply the store. The
  // caller is responsible for snapshotting the current data first. Returns the count restored.
  function replaceAll(nextLicenses) {
    assertLoaded();
    if (!Array.isArray(nextLicenses) || !nextLicenses.every(isValidLicense)) {
      throw new Error('restore payload must be an array of valid license records');
    }
    licenses = nextLicenses;
    persist();
    return licenses.length;
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
    removeLicense,
    replaceAll,
    persist,
    idle,
    get dbPath() {
      return dbPath;
    },
  };
}
