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
  let previousTrustProxy;
  beforeEach(async () => {
    previousAdminToken = process.env.LICENSE_ADMIN_TOKEN;
    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    // Run the suite in proxy-aware mode so per-IP tests can simulate distinct clients via
    // X-Forwarded-For (the anti-spoof default, TRUST_PROXY unset, is covered by its own test below).
    previousTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    await startServer();
  });

  afterEach(async () => {
    if (previousAdminToken === undefined) {
      delete process.env.LICENSE_ADMIN_TOKEN;
    } else {
      process.env.LICENSE_ADMIN_TOKEN = previousAdminToken;
    }
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
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

  it('export returns the exact store, and restore replaces it (with a snapshot + audit) after validating', async () => {
    seedLicense({ seatCap: 2, activations: [{ machineId: 'm1', machineName: 'x', activatedAt: 1, lastSeenAt: 1 }] });

    const unauthorizedExport = await get('/admin/export');
    assert.equal(unauthorizedExport.status, 401);

    const exported = await get('/admin/export', adminHeaders());
    assert.equal(exported.status, 200);
    assert.equal(exported.json.licenses.length, 1);
    assert.equal(exported.json.licenses[0].activations.length, 1);

    // Restore a DIFFERENT dataset (two fresh licenses) and confirm it fully replaces the old one.
    const replacement = [
      { licenseKey: 'ATK-RESTORE-A', companyName: 'Restored A', seatCap: 5, createdAt: 1, expiresAt: null, revoked: false, activations: [] },
      { licenseKey: 'ATK-RESTORE-B', companyName: 'Restored B', seatCap: 3, createdAt: 1, expiresAt: null, revoked: false, activations: [] },
    ];
    const restored = await post('/admin/restore', { licenses: replacement }, adminHeaders());
    assert.equal(restored.status, 200);
    assert.equal(restored.json.ok, true);
    assert.equal(restored.json.restoredCount, 2);

    const after = await get('/admin/export', adminHeaders());
    assert.equal(after.json.licenses.length, 2);
    const gone = await get('/admin/licenses/ATK-0000000000000000TEST', adminHeaders());
    assert.equal(gone.status, 404); // the original was replaced, not merged

    // record() is fire-and-forget (never blocks the request it logs) — reading the audit trail
    // deterministically requires draining the append queue first, per audit.mjs's contract.
    await auditLog.idle();
    const auditRestore = (await get('/admin/audit', adminHeaders())).json.find((e) => e.action === 'restore');
    assert.ok(auditRestore, 'restore is audited');
    assert.equal(auditRestore.details.restoredCount, 2);
  });

  it('restore rejects a malformed payload without mutating the store', async () => {
    seedLicense({ seatCap: 2 });
    const unauthorized = await post('/admin/restore', { licenses: [] });
    assert.equal(unauthorized.status, 401);

    // A license record missing its key is invalid -> 400, store untouched.
    const bad = await post('/admin/restore', { licenses: [{ companyName: 'No Key', seatCap: 1, activations: [] }] }, adminHeaders());
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { ok: false, error: 'invalid_request' });
    assert.equal(Object.prototype.hasOwnProperty.call(bad.json, 'message'), false);
    const still = await get('/admin/export', adminHeaders());
    assert.equal(still.json.licenses.length, 1);
    assert.equal(still.json.licenses[0].licenseKey, 'ATK-0000000000000000TEST');
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

    // Same fire-and-forget contract as above: drain the audit append queue before reading.
    await auditLog.idle();
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

  it('rate-limits a burst of /deactivate calls (429 after the window cap)', async () => {
    seedLicense({ seatCap: 1000 });
    let sawLimited = false;
    for (let i = 0; i < 30; i++) {
      const r = await post('/deactivate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'm-' + i });
      if (r.status === 429) { sawLimited = true; break; }
    }
    assert.equal(sawLimited, true, 'a burst well over the per-minute cap must be rate-limited');
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

  it('exchanges a bearer token for an httpOnly session cookie that can call admin APIs', async () => {
    const res = await fetch(`${baseUrl}/admin/session`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie();
    const line = setCookie.find((c) => c.startsWith('metis_admin_session='));
    assert.ok(line, 'Set-Cookie must include metis_admin_session');
    assert.match(line, /HttpOnly/i);
    assert.match(line, /SameSite=Strict/i);
    assert.doesNotMatch(line, new RegExp(ADMIN_TOKEN));
    const id = /metis_admin_session=([a-f0-9]{64})/.exec(line)?.[1];
    assert.ok(id);
    const list = await get('/admin/licenses', { cookie: `metis_admin_session=${id}` });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json));

    const check = await get('/admin/session', { cookie: `metis_admin_session=${id}` });
    assert.equal(check.status, 200);
    assert.equal(check.json.ok, true);
  });

  it('marks the session cookie Secure on HTTPS and forgets it on DELETE', async () => {
    const res = await fetch(`${baseUrl}/admin/session`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const line = res.headers.getSetCookie().find((c) => c.startsWith('metis_admin_session='));
    assert.match(line, /Secure/i);
    const id = /metis_admin_session=([a-f0-9]{64})/.exec(line)?.[1];

    const gone = await del('/admin/session', { cookie: `metis_admin_session=${id}` });
    assert.equal(gone.status, 200);
    const after = await get('/admin/licenses', { cookie: `metis_admin_session=${id}` });
    assert.equal(after.status, 401);
  });

  it('admin UI HTML never stores the bearer in localStorage', async () => {
    const res = await fetch(`${baseUrl}/admin/ui`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /localStorage/);
    assert.match(html, /\/admin\/session/);
    assert.match(html, /credentials: 'same-origin'/);
  });

  it('attack logs hash the client IP and never print the raw address, token, or license key', async () => {
    const lines = [];
    const orig = console.warn;
    console.warn = (...args) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await get('/admin/licenses', { ...adminHeaders('wrong-token'), 'x-forwarded-for': '203.0.113.88' });
      seedLicense({ seatCap: 1000 });
      for (let i = 0; i < 30; i++) {
        const r = await post(
          '/activate',
          { licenseKey: 'ATK-0000000000000000TEST', machineId: 'log-' + i },
          { 'x-forwarded-for': '198.51.100.44' }
        );
        if (r.status === 429) break;
      }
    } finally {
      console.warn = orig;
    }
    const joined = lines.join('\n');
    assert.match(joined, /admin_auth_failed ip_hash=[a-f0-9]{16}/);
    assert.match(joined, /rate_limited route=\/activate ip_hash=[a-f0-9]{16}/);
    assert.doesNotMatch(joined, /203\.0\.113\.88/);
    assert.doesNotMatch(joined, /198\.51\.100\.44/);
    assert.doesNotMatch(joined, /wrong-token/);
    assert.doesNotMatch(joined, /test-admin-token/);
    assert.doesNotMatch(joined, /ATK-0000000000000000TEST/);
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

  it('GET /admin/stats computes every field correctly from a mixed set of licenses', async () => {
    const now = Date.now();
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
    const TWENTY_DAYS_MS = 20 * 24 * 60 * 60 * 1000;

    // Active, perpetual license with one fresh and one stale activation.
    seedLicense({
      licenseKey: 'ATK-STATS-ACTIVE-0000001',
      companyName: 'Active Co',
      seatCap: 5,
      expiresAt: null,
      revoked: false,
      activations: [
        { machineId: 'a1', machineName: '', activatedAt: now, lastSeenAt: now },
        { machineId: 'a2', machineName: '', activatedAt: now, lastSeenAt: now - THIRTY_ONE_DAYS_MS },
      ],
    });

    // Revoked license (not expired) — counts in revokedLicenses, not in activeLicenses or expiredLicenses.
    seedLicense({
      licenseKey: 'ATK-STATS-REVOKED-000001',
      companyName: 'Revoked Co',
      seatCap: 3,
      expiresAt: now + TWENTY_DAYS_MS, // would otherwise be "expiring soon" if it weren't revoked
      revoked: true,
      activations: [{ machineId: 'r1', machineName: '', activatedAt: now, lastSeenAt: now }],
    });

    // Expired license (not revoked) — counts in expiredLicenses, not in activeLicenses.
    seedLicense({
      licenseKey: 'ATK-STATS-EXPIRED-000001',
      companyName: 'Expired Co',
      seatCap: 2,
      expiresAt: now - 1000,
      revoked: false,
      activations: [{ machineId: 'e1', machineName: '', activatedAt: now, lastSeenAt: now }],
    });

    // Expiring-within-30-days license — active and should appear in expiringSoon.
    seedLicense({
      licenseKey: 'ATK-STATS-SOON-A-0000001',
      companyName: 'Soon Co A',
      seatCap: 1,
      expiresAt: now + TWENTY_DAYS_MS,
      revoked: false,
      activations: [],
    });

    // A second, sooner expiring license, to assert ordering (soonest first).
    seedLicense({
      licenseKey: 'ATK-STATS-SOON-B-0000001',
      companyName: 'Soon Co B',
      seatCap: 1,
      expiresAt: now + FIVE_DAYS_MS,
      revoked: false,
      activations: [],
    });

    // Active but expiring well beyond the 30-day window — must NOT appear in expiringSoon.
    seedLicense({
      licenseKey: 'ATK-STATS-FAR-0000000001',
      companyName: 'Far Co',
      seatCap: 4,
      expiresAt: now + 400 * 24 * 60 * 60 * 1000,
      revoked: false,
      activations: [],
    });

    const { status, json } = await get('/admin/stats', adminHeaders());
    assert.equal(status, 200);

    assert.equal(json.totalLicenses, 6);
    // Active: Active Co, Soon Co A, Soon Co B, Far Co = 4 (Revoked Co and Expired Co excluded).
    assert.equal(json.activeLicenses, 4);
    assert.equal(json.revokedLicenses, 1);
    assert.equal(json.expiredLicenses, 1);
    assert.equal(json.totalSeatCap, 5 + 3 + 2 + 1 + 1 + 4);
    assert.equal(json.totalSeatsUsed, 2 + 1 + 1 + 0 + 0 + 0);
    // Sums freshness across every license's activations, not just active ones: Active Co's a1 (a2 is
    // stale), Revoked Co's r1, and Expired Co's e1 are all within 30 days = 3. Mirrors the existing
    // per-license activeSeats30d convention (adminListView), which also ignores revoked/expired status.
    assert.equal(json.totalActive30d, 3);

    assert.equal(json.expiringSoon.length, 2, 'only the two not-revoked, within-30-day licenses qualify');
    assert.equal(json.expiringSoon[0].licenseKey, 'ATK-STATS-SOON-B-0000001', 'soonest expiry must come first');
    assert.equal(json.expiringSoon[1].licenseKey, 'ATK-STATS-SOON-A-0000001');
    assert.deepEqual(Object.keys(json.expiringSoon[0]).sort(), ['companyName', 'expiresAt', 'licenseKey'].sort());
    assert.equal(json.expiringSoon[0].companyName, 'Soon Co B');
  });

  it('GET /admin/stats requires the admin token', async () => {
    const { status } = await get('/admin/stats');
    assert.equal(status, 401);
  });

  it('locks out an IP after 10 failed admin auth attempts, even for the correct token, until reset', async () => {
    const badHeaders = adminHeaders('totally-wrong-token');

    // 10 failed attempts trip the lockout; none of these should themselves see 429 (the limiter only
    // starts rejecting once the cap is reached, not on the attempt that reaches it).
    for (let i = 0; i < 10; i++) {
      const r = await get('/admin/licenses', badHeaders);
      assert.equal(r.status, 401, `attempt ${i + 1} should still be a plain 401`);
    }

    // The 11th wrong attempt from the same IP must now be locked out.
    const eleventh = await get('/admin/licenses', badHeaders);
    assert.equal(eleventh.status, 429);
    assert.deepEqual(eleventh.json, { ok: false, error: 'too_many_attempts' });

    // Even the genuinely correct token gets 429 during the cooldown.
    const correctDuringCooldown = await get('/admin/licenses', adminHeaders());
    assert.equal(correctDuringCooldown.status, 429);
    assert.deepEqual(correctDuringCooldown.json, { ok: false, error: 'too_many_attempts' });

    // A different IP (simulated via X-Forwarded-For, since trust proxy is on) is entirely unaffected.
    const freshIp = await get('/admin/licenses', { ...badHeaders, 'x-forwarded-for': '203.0.113.9' });
    assert.equal(freshIp.status, 401, 'a fresh IP must not inherit another IP\'s lockout');
  });

  it('a successful admin auth resets the per-IP failure counter', async () => {
    const badHeaders = adminHeaders('totally-wrong-token');

    for (let i = 0; i < 5; i++) {
      const r = await get('/admin/licenses', badHeaders);
      assert.equal(r.status, 401);
    }

    const success = await get('/admin/licenses', adminHeaders());
    assert.equal(success.status, 200);

    // Failure count was reset to 0 by the success above, so 9 more failures (< 10) must not lock us out.
    for (let i = 0; i < 9; i++) {
      const r = await get('/admin/licenses', badHeaders);
      assert.equal(r.status, 401, `post-reset attempt ${i + 1} should still be a plain 401, not locked out`);
    }

    // A subsequent correct call must still succeed (never locked, and no lingering lockout state).
    const stillOk = await get('/admin/licenses', adminHeaders());
    assert.equal(stillOk.status, 200);
  });

  it('does not count the 503 admin-disabled response as a failed attempt', async () => {
    delete process.env.LICENSE_ADMIN_TOKEN;

    for (let i = 0; i < 15; i++) {
      const r = await get('/admin/licenses', adminHeaders('anything'));
      assert.equal(r.status, 503);
    }

    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    // If those 15 attempts had counted as failures, this correct-token call would now be locked out.
    const afterReenable = await get('/admin/licenses', adminHeaders());
    assert.equal(afterReenable.status, 200);
  });

  it('GET /health returns version and uptimeSeconds, and does not disclose licenseCount', async () => {
    seedLicense({ licenseKey: 'ATK-HEALTH-0000000000001' });
    seedLicense({ licenseKey: 'ATK-HEALTH-0000000000002' });

    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.ok, true);
    assert.equal(typeof json.version, 'string');
    assert.match(json.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof json.uptimeSeconds, 'number');
    assert.ok(json.uptimeSeconds >= 0);
    assert.equal(json.licenseCount, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'licenseCount'), false);
  });

  it('GET /health requires no auth', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });
});

// With TRUST_PROXY unset (the safe default for a directly-exposed server), a spoofed X-Forwarded-For
// must be IGNORED, so an attacker can't rotate it to dodge the admin lockout. Own server, no proxy.
describe('license-server (trust proxy OFF, anti-spoof)', () => {
  let prevTok;
  let prevTp;
  beforeEach(async () => {
    prevTok = process.env.LICENSE_ADMIN_TOKEN;
    prevTp = process.env.TRUST_PROXY;
    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.TRUST_PROXY;
    await startServer();
  });
  afterEach(async () => {
    if (prevTok === undefined) delete process.env.LICENSE_ADMIN_TOKEN;
    else process.env.LICENSE_ADMIN_TOKEN = prevTok;
    if (prevTp === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prevTp;
    await stopServer();
  });

  it('a rotated X-Forwarded-For cannot evade the admin lockout when trust proxy is off', async () => {
    const bad = adminHeaders('totally-wrong-token');
    // 10 failures from the real socket IP (127.0.0.1), each with a DIFFERENT spoofed XFF.
    for (let i = 0; i < 10; i++) {
      const r = await get('/admin/licenses', { ...bad, 'x-forwarded-for': `203.0.113.${i}` });
      assert.equal(r.status, 401);
    }
    // A brand-new spoofed XFF must still be locked out, because the real socket IP is what counts.
    const spoofed = await get('/admin/licenses', { ...bad, 'x-forwarded-for': '198.51.100.77' });
    assert.equal(spoofed.status, 429, 'a spoofed XFF must not bypass the lockout with trust proxy off');
  });
});
