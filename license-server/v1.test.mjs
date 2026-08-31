import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';
import { createAuditLog } from './lib/audit.mjs';

let server;
let store;
let auditLog;
let baseUrl;
let tmpDir;

async function startServer() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'license-v1-'));
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
  await store.idle();
  await auditLog.idle();
  await rm(tmpDir, { recursive: true, force: true });
}

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('v1 reserved routes stay closed', () => {
  beforeEach(startServer);
  afterEach(stopServer);

  it('POST /v1/licenses/activate returns activation_unavailable', async () => {
    const r = await post('/v1/licenses/activate', {
      licenseKey: 'ATK-7QHM2K9X3VBN8ZC1FGJ0',
      deviceIdHash: 'ab'.repeat(32),
      appVersion: '1.6.6',
      os: 'darwin',
    });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { ok: false, error: 'activation_unavailable' });
  });

  it('POST /v1/installs/register returns activation_unavailable and never invents a number', async () => {
    const r = await post('/v1/installs/register', {
      installId: '11111111-1111-4111-8111-111111111111',
      appVersion: '1.6.6',
      os: 'darwin',
    });
    assert.equal(r.status, 503);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'activation_unavailable');
    assert.equal(r.json.memberNumber, undefined);
  });

  it('legacy /activate is unchanged (still 400 without a real key, not 503)', async () => {
    const r = await post('/activate', { licenseKey: 'ATK-DOESNOTEXIST00000000', machineId: 'm1' });
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'invalid');
  });
});
