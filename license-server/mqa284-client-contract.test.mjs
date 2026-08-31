// MQA-284 — this server (license-server/) and the Act 5 onboarding client (src/main/license.ts,
// license-lease-verify.ts, license-lease-key.ts) were folded in from two different branches: the
// client's schemas/verifier already assumed a server that could issue leases, mint trials, and declare
// its license-gate config — but the license-server actually checked into this branch (merge-base
// 23c785e) predated ALL of that: `/activate`/`/heartbeat` never returned a `lease` field, `GET
// /license/pubkey`, `POST /admin/licenses/trial`, and `GET /license/config` did not exist at all (a
// 404, not a `{ok:false}`), so `verifyLease()` could never take its stronger tamper-resistant path,
// `fetchLicenseConfig()` could never succeed, and an operator had no way to mint a trial key.
//
// This file is NOT a duplicate of server.test.mjs's own lease/trial/config coverage above — those pin
// each endpoint's OWN behavior. This one pins the CONTRACT boundary itself: the literal field names and
// types the client-side zod schemas require (see src/main/license.ts's ServerOkSchema /
// LicenseConfigResponseSchema, quoted inline below so a future edit to either side that drifts the
// shape fails HERE, at the seam, not just deep inside a client-only or server-only test suite that
// never cross-checks the other side).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';
import { createAuditLog } from './lib/audit.mjs';
import { generateLeaseKeyPair, loadLeaseSigningKey, verifyLease } from './lib/lease.mjs';

const ADMIN_TOKEN = 'mqa284-admin-token';

let server;
let store;
let auditLog;
let baseUrl;
let tmpDir;
let leaseSigningKey;
let previousAdminToken;

async function startServer() {
  previousAdminToken = process.env.LICENSE_ADMIN_TOKEN;
  process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
  tmpDir = await mkdtemp(path.join(tmpdir(), 'license-server-mqa284-'));
  const dbPath = path.join(tmpDir, 'licenses.json');
  store = createStore(dbPath);
  await store.load();
  auditLog = createAuditLog(dbPath);
  const { privateKeyPem } = generateLeaseKeyPair();
  leaseSigningKey = loadLeaseSigningKey(privateKeyPem);
  const app = createApp(store, auditLog, { leaseSigningKey });
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
  if (previousAdminToken === undefined) delete process.env.LICENSE_ADMIN_TOKEN;
  else process.env.LICENSE_ADMIN_TOKEN = previousAdminToken;
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

async function post(pathname, body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

describe('MQA-284 — license-server response shapes match the already-merged client schemas', () => {
  beforeEach(startServer);
  afterEach(stopServer);

  it('/activate matches ServerOkSchema (license.ts): ok, companyName, seatCap, seatsUsed, expiresAt, lease?', async () => {
    seedLicense({ companyName: 'Contract Co', seatCap: 3 });
    const { status, json } = await post('/activate', {
      licenseKey: 'ATK-0000000000000000TEST',
      machineId: 'contract-machine-1',
    });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(typeof json.companyName, 'string');
    assert.equal(typeof json.seatCap, 'number');
    assert.equal(typeof json.seatsUsed, 'number');
    assert.ok(json.expiresAt === null || typeof json.expiresAt === 'number');
    // lease is OPTIONAL in the schema (z.string().optional()) — when present, it must already be a
    // verifiable, correctly-shaped compact token, not just any string.
    assert.equal(typeof json.lease, 'string');
    assert.match(json.lease, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(verifyLease(json.lease, leaseSigningKey.publicKey));
  });

  it('/activate error codes are exactly the five ServerErrSchema enum members the client parses', async () => {
    // ServerErrSchema: z.enum(['invalid', 'revoked', 'expired', 'seat_limit_reached', 'not_activated'])
    const invalid = await post('/activate', { licenseKey: 'ATK-DOESNOTEXIST00000000', machineId: 'm1' });
    assert.equal(invalid.json.ok, false);
    assert.equal(invalid.json.error, 'invalid');

    seedLicense({ licenseKey: 'ATK-000000000000000REVK1', revoked: true });
    const revoked = await post('/activate', { licenseKey: 'ATK-000000000000000REVK1', machineId: 'm1' });
    assert.equal(revoked.json.error, 'revoked');

    seedLicense({ licenseKey: 'ATK-000000000000000EXPD1', expiresAt: Date.now() - 1000 });
    const expired = await post('/activate', { licenseKey: 'ATK-000000000000000EXPD1', machineId: 'm1' });
    assert.equal(expired.json.error, 'expired');

    seedLicense({ licenseKey: 'ATK-000000000000000CAP01', seatCap: 1 });
    await post('/activate', { licenseKey: 'ATK-000000000000000CAP01', machineId: 'm1' });
    const capped = await post('/activate', { licenseKey: 'ATK-000000000000000CAP01', machineId: 'm2' });
    assert.equal(capped.json.error, 'seat_limit_reached');

    seedLicense({ licenseKey: 'ATK-000000000000000NACT1' });
    const notActivated = await post('/heartbeat', { licenseKey: 'ATK-000000000000000NACT1', machineId: 'never-seen' });
    assert.equal(notActivated.json.error, 'not_activated');
  });

  it('GET /license/pubkey matches license-lease-key.ts\'s expected { ok, algorithm, publicKey } shape', async () => {
    const { status, json } = await get('/license/pubkey');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.algorithm, 'ed25519');
    assert.equal(typeof json.publicKey, 'string');
    // Must be the raw base64url JWK `x` value license-lease-verify.ts's rawToPublicKey expects —
    // reconstructing a KeyObject from it must not throw.
    const { rawToPublicKey } = await import('./lib/lease.mjs');
    assert.doesNotThrow(() => rawToPublicKey(json.publicKey));
  });

  it('GET /license/config matches LicenseConfigResponseSchema (license.ts): ok, licenseEnforcement, licenseUiEnabled, drift', async () => {
    const { status, json } = await get('/license/config');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(typeof json.licenseEnforcement, 'boolean');
    assert.equal(typeof json.licenseUiEnabled, 'boolean');
    assert.equal(typeof json.drift, 'boolean');
  });

  it('POST /admin/licenses/trial exists and mints a key the client can activate with, unblocking the onboarding trial path', async () => {
    // No admin header at all — pins that the route exists (would be a 404 route-not-found on the
    // pre-fold server, not this auth rejection).
    const unauthed = await post('/admin/licenses/trial', {});
    assert.notEqual(unauthed.status, 404);
    assert.equal(unauthed.json.ok, false);

    const authedRes = await fetch(`${baseUrl}/admin/licenses/trial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({}),
    });
    const minted = await authedRes.json();
    assert.equal(authedRes.status, 201);
    assert.equal(typeof minted.licenseKey, 'string');
    assert.equal(minted.trial, true);

    // The freshly-minted trial key activates through the exact same client-facing /activate contract
    // as any sold license — no separate "trial activation" endpoint the client would need to know about.
    const activated = await post('/activate', { licenseKey: minted.licenseKey, machineId: 'trial-machine-1' });
    assert.equal(activated.json.ok, true);
    assert.equal(typeof activated.json.lease, 'string');
  });
});
