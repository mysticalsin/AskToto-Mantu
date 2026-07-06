import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';

const ADMIN_TOKEN = 'test-admin-token';

let server;
let store;
let baseUrl;
let tmpDir;
let previousAdminToken;

async function startServer() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'license-server-test-'));
  const dbPath = path.join(tmpDir, 'licenses.json');
  store = createStore(dbPath);
  await store.load();
  const app = createApp(store);
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
});
