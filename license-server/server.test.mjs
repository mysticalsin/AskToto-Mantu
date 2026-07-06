import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';
import { createAuditLog } from './lib/audit.mjs';

const ADMIN_TOKEN = 'test-admin-token';
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;

let server;
let store;
let auditLog;
let baseUrl;
let tmpDir;
let previousAdminToken;

async function startServer() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'license-server-test-'));
  const dbPath = path.join(tmpDir, 'licenses.json');
  store = createStore(dbPath);
  await store.load();
  auditLog = createAuditLog(dbPath);
  const app = createApp(store, auditLog);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stopServer() {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // Wait for any writes still in flight before deleting the data directory,
  // otherwise a pending rename() can race the rm() and throw ENOENT/EINVAL.
  await store.idle();
  await auditLog.idle();
  await rm(tmpDir, { recursive: true, force: true });
}

function seedLicense(overrides = {}) {
  const license = {
    licenseKey: overrides.licenseKey || 'ATK-0000000000000000TEST',
    companyName: overrides.companyName || 'Acme Corp',
    seatCap: overrides.seatCap ?? 2,
    createdAt: overrides.createdAt ?? Date.now(),
    expiresAt: overrides.expiresAt ?? null,
    revoked: overrides.revoked ?? false,
    activations: overrides.activations || [],
  };
  store.getAll().push(license);
  return license;
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function patch(pathname, body, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function get(pathname, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, { headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function del(pathname, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, { method: 'DELETE', headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function adminHeaders(token = ADMIN_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

describe('license-server', () => {
  beforeEach(async () => {
    previousAdminToken = process.env.LICENSE_ADMIN_TOKEN;
    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    await startServer();
  });

  afterEach(async () => {
    if (previousAdminToken === undefined) {
      delete process.env.LICENSE_ADMIN_TOKEN;
    } else {
      process.env.LICENSE_ADMIN_TOKEN = previousAdminToken;
    }
    await stopServer();
  });

  it('activates successfully and returns seat usage', async () => {
    seedLicense({ seatCap: 2 });
    const { status, json } = await post('/activate', {
      licenseKey: 'ATK-0000000000000000TEST',
      machineId: 'machine-1',
      machineName: 'Tony’s MacBook',
    });

    assert.equal(status, 200);
    assert.deepEqual(json, {
      ok: true,
      companyName: 'Acme Corp',
      seatCap: 2,
      seatsUsed: 1,
      expiresAt: null,
    });
  });

  it('rejects activation once the seat cap is reached', async () => {
    seedLicense({ seatCap: 1 });

    const first = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.equal(first.json.ok, true);
    assert.equal(first.json.seatsUsed, 1);

    const second = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-2' });
    assert.deepEqual(second.json, { ok: false, error: 'seat_limit_reached' });
  });

  it('rate-limits a burst of /activate calls (429 after the window cap)', async () => {
    seedLicense({ seatCap: 1000 });
    let sawLimited = false;
    // The cap is 20/min per IP+key; well past it, we must start getting 429s.
    for (let i = 0; i < 30; i++) {
      const r = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'm-' + i });
      if (r.status === 429) { sawLimited = true; break; }
    }
    assert.equal(sawLimited, true, 'a burst well over the per-minute cap must be rate-limited');
  });

  it('re-activating the same machineId is idempotent and does not consume an extra seat', async () => {
    seedLicense({ seatCap: 1 });

    const first = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.equal(first.json.seatsUsed, 1);

    const second = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.equal(second.json.ok, true);
    assert.equal(second.json.seatsUsed, 1);

    const detail = await get('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(detail.json.activations.length, 1);
  });

  it('heartbeat re-validates an activated machine without consuming a seat', async () => {
    seedLicense({ seatCap: 1 });
    await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });

    const beat = await post('/heartbeat', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.equal(beat.json.ok, true);
    assert.equal(beat.json.seatsUsed, 1);

    const unactivated = await post('/heartbeat', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'never-activated' });
    assert.deepEqual(unactivated.json, { ok: false, error: 'not_activated' });
  });

  it('revoking a license blocks subsequent activate and heartbeat calls', async () => {
    seedLicense({ seatCap: 2 });
    await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });

    const revoke = await post('/admin/licenses/ATK-0000000000000000TEST/revoke', {}, adminHeaders());
    assert.equal(revoke.status, 200);
    assert.equal(revoke.json.revoked, true);

    const activate = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-2' });
    assert.deepEqual(activate.json, { ok: false, error: 'revoked' });

    const heartbeat = await post('/heartbeat', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.deepEqual(heartbeat.json, { ok: false, error: 'revoked' });
  });

  it('delete permanently removes a license, audits a snapshot, and requires the admin token', async () => {
    seedLicense({ seatCap: 2 });

    const unauthorized = await del('/admin/licenses/ATK-0000000000000000TEST');
    assert.equal(unauthorized.status, 401);

    const deleted = await del('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { ok: true });

    const detail = await get('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(detail.status, 404);

    const again = await del('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(again.status, 404);

    const audit = await get('/admin/audit', adminHeaders());
    assert.equal(audit.status, 200);
    const entry = audit.json.find((e) => e.action === 'delete');
    assert.ok(entry, 'delete action is audited');
    assert.equal(entry.licenseKey, 'ATK-0000000000000000TEST');
    assert.equal(entry.details.companyName, 'Acme Corp');
  });

  it('deactivate frees a seat for a new activation', async () => {
    seedLicense({ seatCap: 1 });
    await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });

    const full = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-2' });
    assert.deepEqual(full.json, { ok: false, error: 'seat_limit_reached' });

    const deactivate = await post('/deactivate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.deepEqual(deactivate.json, { ok: true });

    const retry = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-2' });
    assert.equal(retry.json.ok, true);
    assert.equal(retry.json.seatsUsed, 1);
  });

  it('rejects an unknown license key', async () => {
    const { json } = await post('/activate', { licenseKey: 'ATK-DOESNOTEXIST00000000', machineId: 'machine-1' });
    assert.deepEqual(json, { ok: false, error: 'invalid' });
  });

  it('rejects an expired license', async () => {
    seedLicense({ seatCap: 2, expiresAt: Date.now() - 1000 });
    const { json } = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'machine-1' });
    assert.deepEqual(json, { ok: false, error: 'expired' });
  });

  it('admin routes reject a missing or wrong bearer token', async () => {
    const noAuth = await get('/admin/licenses');
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.error, 'unauthorized');

    const wrongAuth = await get('/admin/licenses', adminHeaders('not-the-right-token'));
    assert.equal(wrongAuth.status, 401);
    assert.equal(wrongAuth.json.error, 'unauthorized');
  });

  it('admin routes return 503 when LICENSE_ADMIN_TOKEN is not configured', async () => {
    delete process.env.LICENSE_ADMIN_TOKEN;

    const { status, json } = await get('/admin/licenses', adminHeaders());
    assert.equal(status, 503);
    assert.equal(json.error, 'admin_disabled');
  });

  it('admin can create a license and it round-trips through list/detail/patch', async () => {
    const created = await post(
      '/admin/licenses',
      { companyName: 'New Co', seatCap: 5 },
      adminHeaders()
    );
    assert.equal(created.status, 201);
    assert.match(created.json.licenseKey, /^ATK-[0-9A-Z]{20}$/);
    assert.equal(created.json.companyName, 'New Co');

    const list = await get('/admin/licenses', adminHeaders());
    assert.equal(list.status, 200);
    const entry = list.json.find((l) => l.licenseKey === created.json.licenseKey);
    assert.ok(entry, 'created license should appear in list');
    assert.equal(entry.activations, undefined, 'list view must not include raw activations');

    const patched = await patch(
      `/admin/licenses/${created.json.licenseKey}`,
      { seatCap: 10 },
      adminHeaders()
    );
    assert.equal(patched.status, 200);
    assert.equal(patched.json.seatCap, 10);
    assert.ok(Array.isArray(patched.json.activations));
  });

  it('GET /admin/ui serves the admin dashboard page without requiring auth', async () => {
    const res = await fetch(`${baseUrl}/admin/ui`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    assert.match(body, /AskToto licenses/);
  });

  it('GET /admin redirects to /admin/ui', async () => {
    const res = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin/ui');
  });

  it('metadata round-trips through create, detail, list, and patch', async () => {
    const created = await post(
      '/admin/licenses',
      {
        companyName: 'Meta Co',
        seatCap: 3,
        contactName: 'Jane Doe',
        contactEmail: 'jane@meta.co',
        notes: 'Signed on the enterprise plan.',
      },
      adminHeaders()
    );
    assert.equal(created.status, 201);

    const detail = await get(`/admin/licenses/${created.json.licenseKey}`, adminHeaders());
    assert.equal(detail.json.contactName, 'Jane Doe');
    assert.equal(detail.json.contactEmail, 'jane@meta.co');
    assert.equal(detail.json.notes, 'Signed on the enterprise plan.');

    const list = await get('/admin/licenses', adminHeaders());
    const entry = list.json.find((l) => l.licenseKey === created.json.licenseKey);
    assert.equal(entry.contactName, 'Jane Doe');
    assert.equal(entry.notes, undefined, 'list view must not include notes');
    assert.equal(entry.contactEmail, undefined, 'list view must not include contactEmail');

    const patched = await patch(`/admin/licenses/${created.json.licenseKey}`, { notes: 'Renewed for another year.' }, adminHeaders());
    assert.equal(patched.status, 200);
    assert.equal(patched.json.notes, 'Renewed for another year.');
    assert.equal(patched.json.contactName, 'Jane Doe', 'unrelated metadata fields survive a partial patch');
  });

  it('defaults missing metadata fields to empty strings for pre-existing licenses', async () => {
    seedLicense({ seatCap: 1 }); // no contactName/contactEmail/notes on this record at all
    const detail = await get('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(detail.json.contactName, '');
    assert.equal(detail.json.contactEmail, '');
    assert.equal(detail.json.notes, '');
  });

  it('records an audit entry for create and revoke, newest first', async () => {
    const created = await post('/admin/licenses', { companyName: 'Audit Co', seatCap: 2 }, adminHeaders());
    await post(`/admin/licenses/${created.json.licenseKey}/revoke`, {}, adminHeaders());
    await auditLog.idle();

    const audit = await get('/admin/audit', adminHeaders());
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.json));
    assert.equal(audit.json[0].action, 'revoke');
    assert.equal(audit.json[0].licenseKey, created.json.licenseKey);
    assert.ok(typeof audit.json[0].at === 'number');

    const createEntry = audit.json.find((e) => e.action === 'create' && e.licenseKey === created.json.licenseKey);
    assert.ok(createEntry, 'create action should be recorded');
  });

  it('activeSeats30d counts only activations seen within the last 30 days', async () => {
    const license = seedLicense({
      seatCap: 2,
      activations: [
        { machineId: 'fresh', machineName: 'Fresh', activatedAt: Date.now(), lastSeenAt: Date.now() },
        { machineId: 'stale', machineName: 'Stale', activatedAt: Date.now(), lastSeenAt: Date.now() },
      ],
    });
    // Backdate one activation's lastSeenAt via the store, past the 30-day window.
    const stored = store.findByKey(license.licenseKey);
    stored.activations.find((a) => a.machineId === 'stale').lastSeenAt = Date.now() - THIRTY_ONE_DAYS_MS;

    const list = await get('/admin/licenses', adminHeaders());
    const entry = list.json.find((l) => l.licenseKey === license.licenseKey);
    assert.equal(entry.seatsUsed, 2);
    assert.equal(entry.activeSeats30d, 1);
  });

  it('CSV export returns a header row and quotes fields that need it', async () => {
    await post('/admin/licenses', { companyName: 'Comma, Inc.', seatCap: 4 }, adminHeaders());

    const res = await fetch(`${baseUrl}/admin/licenses.csv`, { headers: adminHeaders() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/csv/);
    const body = await res.text();
    const [header, ...rows] = body.split('\r\n');
    assert.equal(
      header,
      'companyName,licenseKey,seatCap,seatsUsed,activeSeats30d,revoked,createdAt,expiresAt,contactName,contactEmail'
    );
    assert.ok(rows.some((row) => row.startsWith('"Comma, Inc."')));
  });

  it('CSV and audit endpoints require the admin token', async () => {
    const csv = await get('/admin/licenses.csv');
    assert.equal(csv.status, 401);

    const audit = await get('/admin/audit');
    assert.equal(audit.status, 401);
  });
});
