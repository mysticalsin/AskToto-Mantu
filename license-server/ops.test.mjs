// Tests for the operations layer: server-side backups, webhook notifications, Prometheus
// metrics, and the analytics aggregates. Same harness discipline as server.test.mjs (real HTTP
// against an app instance on an ephemeral port, isolated temp-dir store per test).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { createApp } from './lib/app.mjs';
import { createStore } from './lib/store.mjs';
import { createAuditLog } from './lib/audit.mjs';
import { createBackupManager } from './lib/backups.mjs';
import { createWebhooks, isDiscordWebhookUrl, formatDiscordPayload, licenseEventView } from './lib/webhooks.mjs';
import { computeAnalytics } from './lib/license.mjs';
import { resolveLicenseGateConfig } from './lib/license-gate.mjs';

const ADMIN_TOKEN = 'test-admin-token';
const METRICS_TOKEN = 'test-metrics-token';
const WEBHOOK_SECRET = 'test-webhook-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

let server;
let store;
let auditLog;
let backups;
let webhooks;
let baseUrl;
let tmpDir;
let previousAdminToken;
let previousMetricsToken;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(options = {}) {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'license-ops-test-'));
  const dbPath = path.join(tmpDir, 'licenses.json');
  store = createStore(dbPath);
  await store.load();
  auditLog = createAuditLog(dbPath);
  backups = options.noBackups
    ? null
    : createBackupManager(store, { dir: path.join(tmpDir, 'backups'), keep: options.keep ?? 30, version: '1.0.0' });
  webhooks = options.webhooks || null;
  const app = createApp(store, auditLog, { backups: backups || undefined, webhooks: webhooks || undefined });
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
  if (webhooks) await webhooks.idle();
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
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function get(pathname, headers = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text endpoints (metrics, downloads) stay as text */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function adminHeaders(token = ADMIN_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

// Minimal local webhook receiver: records every request; `respond(record, n)` picks the status.
function startReceiver(respond) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const record = { headers: req.headers, body };
        requests.push(record);
        res.statusCode = respond ? respond(record, requests.length) : 200;
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        requests,
        url: `http://127.0.0.1:${srv.address().port}/hook`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

describe('ops layer', () => {
  beforeEach(async () => {
    previousAdminToken = process.env.LICENSE_ADMIN_TOKEN;
    previousMetricsToken = process.env.METRICS_TOKEN;
    process.env.LICENSE_ADMIN_TOKEN = ADMIN_TOKEN;
    delete process.env.METRICS_TOKEN;
  });

  afterEach(async () => {
    if (previousAdminToken === undefined) delete process.env.LICENSE_ADMIN_TOKEN;
    else process.env.LICENSE_ADMIN_TOKEN = previousAdminToken;
    if (previousMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = previousMetricsToken;
    if (server) {
      await stopServer();
      server = null;
    }
  });

  // ---------- backups ----------

  it('writes an on-demand backup, lists it, and the snapshot is restore-compatible', async () => {
    await startServer();
    seedLicense({ activations: [{ machineId: 'm1', machineName: 'Mac', activatedAt: Date.now(), lastSeenAt: Date.now() }] });

    const backup = await post('/admin/backup', undefined, adminHeaders());
    assert.equal(backup.status, 200);
    assert.equal(backup.json.ok, true);
    assert.match(backup.json.file, /^licenses-backup-.+\.json$/);
    assert.equal(backup.json.licenseCount, 1);

    const list = await get('/admin/backups', adminHeaders());
    assert.equal(list.status, 200);
    assert.equal(list.json.files.length, 1);
    assert.equal(list.json.files[0].name, backup.json.file);

    // The snapshot on disk is the exact /admin/export wrapper — feed it back to /admin/restore.
    const raw = await readFile(path.join(tmpDir, 'backups', backup.json.file), 'utf8');
    const snapshot = JSON.parse(raw);
    assert.ok(Array.isArray(snapshot.licenses));
    const restore = await post('/admin/restore', snapshot, adminHeaders());
    assert.equal(restore.status, 200);
    assert.equal(restore.json.restoredCount, 1);
  });

  it('skips a scheduled backup when nothing changed, but force always writes', async () => {
    await startServer();
    seedLicense();

    const first = await backups.runBackupNow();
    assert.equal(first.skipped, undefined);
    assert.match(first.name, /^licenses-backup-/);

    const second = await backups.runBackupNow();
    assert.equal(second.skipped, true);

    const forced = await backups.runBackupNow({ force: true });
    assert.equal(forced.skipped, undefined);
    assert.match(forced.name, /^licenses-backup-/);

    seedLicense({ licenseKey: 'ATK-0000000000000000TWO0', companyName: 'Second Co' });
    const afterChange = await backups.runBackupNow();
    assert.equal(afterChange.skipped, undefined);
  });

  it('prunes old snapshots past the retention cap', async () => {
    await startServer({ keep: 2 });
    for (let i = 0; i < 3; i += 1) {
      seedLicense({ licenseKey: `ATK-000000000000000000${i}0`, companyName: `Co ${i}` });
      const result = await backups.runBackupNow();
      assert.equal(result.skipped, undefined);
      await sleep(5); // distinct filename stamps
    }
    const files = await backups.listFiles();
    assert.equal(files.length, 2);
  });

  it('downloads a snapshot by name and rejects traversal-shaped names', async () => {
    await startServer();
    seedLicense();
    const backup = await post('/admin/backup', undefined, adminHeaders());

    const download = await get(`/admin/backups/${backup.json.file}`, adminHeaders());
    assert.equal(download.status, 200);
    const parsed = JSON.parse(download.text);
    assert.equal(parsed.licenses.length, 1);

    const traversal = await get('/admin/backups/..%2Flicenses.json', adminHeaders());
    assert.equal(traversal.status, 400);
    const wrongShape = await get('/admin/backups/evil.json', adminHeaders());
    assert.equal(wrongShape.status, 400);
    const missing = await get('/admin/backups/licenses-backup-2000-01-01T00-00-00-000Z.json', adminHeaders());
    assert.equal(missing.status, 404);
  });

  it('backup routes 503 when no backup manager is wired in, and all require admin auth', async () => {
    await startServer({ noBackups: true });
    const noAuth = await post('/admin/backup');
    assert.equal(noAuth.status, 401);
    const noAuthList = await get('/admin/backups');
    assert.equal(noAuthList.status, 401);
    const noAuthDownload = await get('/admin/backups/licenses-backup-2000-01-01T00-00-00-000Z.json');
    assert.equal(noAuthDownload.status, 401);
    const disabled = await post('/admin/backup', undefined, adminHeaders());
    assert.equal(disabled.status, 503);
    assert.equal(disabled.json.error, 'backups_disabled');
    const disabledList = await get('/admin/backups', adminHeaders());
    assert.equal(disabledList.status, 503);
  });

  it('two forced backups in quick succession never collide on the same filename', async () => {
    await startServer();
    seedLicense();
    const first = await backups.runBackupNow({ force: true });
    const second = await backups.runBackupNow({ force: true });
    assert.notEqual(first.name, second.name);
    const files = await backups.listFiles();
    assert.equal(files.length, 2);
  });

  it('re-arms the expiring-soon reminder when every delivery attempt fails', async () => {
    // Receiver rejects with 500 for the first sweep's 3 attempts (uses ~6s of retry waits), then
    // accepts. Cheaper: fail with terminal 400 first — one attempt, delivered=false, re-arm.
    let mode = 'reject';
    const receiver = await startReceiver(() => (mode === 'reject' ? 400 : 200));
    try {
      const hooks = createWebhooks({ url: receiver.url, expiryAlertDays: 14 });
      await startServer({ webhooks: hooks });
      seedLicense({ licenseKey: 'ATK-000000000000000SOON', companyName: 'Soon Co', expiresAt: Date.now() + 7 * DAY_MS });

      await hooks.sweepExpiring(store);
      await hooks.idle();
      assert.equal(receiver.requests.length, 1); // attempted once, rejected terminally

      mode = 'accept';
      await hooks.sweepExpiring(store); // re-armed — sweeps again instead of staying silent
      await hooks.idle();
      assert.equal(receiver.requests.length, 2);
      assert.equal(JSON.parse(receiver.requests[1].body).event, 'license.expiring_soon');

      await hooks.sweepExpiring(store); // delivered — now it stays deduped
      await hooks.idle();
      assert.equal(receiver.requests.length, 2);
    } finally {
      await receiver.close();
    }
  });

  it('detects Discord webhook URLs and formats events as embeds without the full key', () => {
    assert.equal(isDiscordWebhookUrl('https://discord.com/api/webhooks/123/abc'), true);
    assert.equal(isDiscordWebhookUrl('https://discordapp.com/api/webhooks/123/abc'), true);
    assert.equal(isDiscordWebhookUrl('https://canary.discord.com/api/webhooks/123/abc'), true);
    assert.equal(isDiscordWebhookUrl('https://evil.com/https://discord.com/api/webhooks/x'), false);
    assert.equal(isDiscordWebhookUrl('https://hooks.example.com/asktoto'), false);

    const at = Date.UTC(2026, 6, 6, 12, 0, 0);
    const payload = formatDiscordPayload('license.expiring_soon', at, {
      license: {
        licenseKey: 'ATK-HY2JVMZ3P3JF8CGAQWPR',
        companyName: 'Mantu',
        seatCap: 50,
        seatsUsed: 3,
        expiresAt: at + 7 * DAY_MS,
        revoked: false,
      },
      details: { daysLeft: 7 },
    });
    assert.equal(payload.embeds.length, 1);
    const embed = payload.embeds[0];
    assert.equal(embed.title, 'License expiring soon — Mantu');
    assert.equal(embed.timestamp, new Date(at).toISOString());
    assert.ok(embed.fields.some((f) => f.name === 'Days left' && f.value === '7'));
    assert.ok(embed.fields.some((f) => f.name === 'Seats' && f.value === '3 / 50'));
    // A chat channel never gets the full activatable key.
    assert.ok(!JSON.stringify(payload).includes('ATK-HY2JVMZ3P3JF8CGAQWPR'));
    assert.ok(embed.fields.some((f) => f.name === 'Key' && f.value === 'ATK-HY2J…QWPR'));
  });

  it('sends Discord-shaped bodies to Discord URLs and generic JSON elsewhere', async () => {
    const calls = [];
    const fakeFetch = async (u, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 204 };
    };
    const license = { licenseKey: 'ATK-0000000000000000TEST', companyName: 'Acme', seatCap: 2, seatsUsed: 0, expiresAt: null, revoked: false };

    const discordHooks = createWebhooks({ url: 'https://discord.com/api/webhooks/1/tok', fetchImpl: fakeFetch });
    await discordHooks.emit('license.created', { license });
    assert.ok(Array.isArray(calls[0].embeds));
    assert.equal(calls[0].event, undefined);

    const genericHooks = createWebhooks({ url: 'https://hooks.example.com/asktoto', fetchImpl: fakeFetch });
    await genericHooks.emit('license.created', { license });
    assert.equal(calls[1].event, 'license.created');
    assert.equal(calls[1].embeds, undefined);
  });

  it('licenseEventView truncates the key unless LICENSE_WEBHOOK_FULL_KEYS is set', () => {
    const license = {
      licenseKey: 'ATK-HY2JVMZ3P3JF8CGAQWPR',
      companyName: 'Mantu',
      seatCap: 2,
      activations: [],
      expiresAt: null,
      revoked: false,
    };
    const prev = process.env.LICENSE_WEBHOOK_FULL_KEYS;
    delete process.env.LICENSE_WEBHOOK_FULL_KEYS;
    try {
      assert.equal(licenseEventView(license).licenseKey, 'ATK-HY2J…QWPR');
      process.env.LICENSE_WEBHOOK_FULL_KEYS = '1';
      assert.equal(licenseEventView(license).licenseKey, 'ATK-HY2JVMZ3P3JF8CGAQWPR');
    } finally {
      if (prev === undefined) delete process.env.LICENSE_WEBHOOK_FULL_KEYS;
      else process.env.LICENSE_WEBHOOK_FULL_KEYS = prev;
    }
  });

  it('retries a 429 rate-limit response instead of dropping the event', async () => {
    const limited = await startReceiver((record, n) => (n === 1 ? 429 : 200));
    try {
      const hooks = createWebhooks({ url: limited.url });
      const delivered = await hooks.emit('test.event', { details: { n: 3 } });
      assert.equal(delivered, true);
      assert.equal(limited.requests.length, 2);
    } finally {
      await limited.close();
    }
  });

  // ---------- webhooks ----------

  it('delivers signed webhook events for admin mutations', async () => {
    const receiver = await startReceiver();
    try {
      await startServer({ webhooks: createWebhooks({ url: receiver.url, secret: WEBHOOK_SECRET }) });
      const created = await post(
        '/admin/licenses',
        { companyName: 'Hook Co', seatCap: 3 },
        adminHeaders()
      );
      assert.equal(created.status, 201);
      await webhooks.idle();

      assert.equal(receiver.requests.length, 1);
      const delivery = receiver.requests[0];
      const payload = JSON.parse(delivery.body);
    assert.equal(payload.event, 'license.created');
    assert.equal(payload.license.companyName, 'Hook Co');
    assert.equal(payload.license.seatCap, 3);
    assert.ok(!delivery.body.includes(created.json.licenseKey), 'generic webhooks must not carry the full activatable key');
    assert.match(payload.license.licenseKey, /^ATK-[0-9A-Z]{4}…[0-9A-Z]{4}$/);

      const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(delivery.body).digest('hex')}`;
      assert.equal(delivery.headers['x-asktoto-signature'], expected);
    } finally {
      await receiver.close();
    }
  });

  it('retries a failed delivery, but never retries a 4xx rejection', async () => {
    const flaky = await startReceiver((record, n) => (n === 1 ? 500 : 200));
    try {
      const hooks = createWebhooks({ url: flaky.url });
      await hooks.emit('test.event', { details: { n: 1 } });
      assert.equal(flaky.requests.length, 2); // failed once, succeeded on retry
    } finally {
      await flaky.close();
    }

    const rejecting = await startReceiver(() => 400);
    try {
      const hooks = createWebhooks({ url: rejecting.url });
      await hooks.emit('test.event', { details: { n: 2 } });
      await sleep(50);
      assert.equal(rejecting.requests.length, 1); // 4xx is terminal — no retry
    } finally {
      await rejecting.close();
    }
  });

  it('throttles seat-limit events and fires them from a real capped /activate', async () => {
    const receiver = await startReceiver();
    try {
      await startServer({ webhooks: createWebhooks({ url: receiver.url }) });
      seedLicense({ seatCap: 1 });
      const ok = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'm1' });
      assert.equal(ok.json.ok, true);

      const bounced = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'm2' });
      assert.equal(bounced.json.error, 'seat_limit_reached');
      const bouncedAgain = await post('/activate', { licenseKey: 'ATK-0000000000000000TEST', machineId: 'm3' });
      assert.equal(bouncedAgain.json.error, 'seat_limit_reached');
      await webhooks.idle();

      const seatLimitEvents = receiver.requests.filter((r) => JSON.parse(r.body).event === 'license.seat_limit');
      assert.equal(seatLimitEvents.length, 1); // second bounce throttled
    } finally {
      await receiver.close();
    }
  });

  it('sweeps expiring licenses once per expiry date, skipping revoked and lapsed ones', async () => {
    const receiver = await startReceiver();
    try {
      await startServer({ webhooks: createWebhooks({ url: receiver.url, expiryAlertDays: 14 }) });
      const now = Date.now();
      seedLicense({ licenseKey: 'ATK-000000000000000SOON', companyName: 'Soon Co', expiresAt: now + 7 * DAY_MS });
      seedLicense({ licenseKey: 'ATK-000000000000000FAR0', companyName: 'Far Co', expiresAt: now + 60 * DAY_MS });
      seedLicense({ licenseKey: 'ATK-000000000000000GONE', companyName: 'Gone Co', expiresAt: now - DAY_MS });
      seedLicense({ licenseKey: 'ATK-000000000000000REVK', companyName: 'Revoked Co', expiresAt: now + 7 * DAY_MS, revoked: true });

      await webhooks.sweepExpiring(store);
      await webhooks.idle();
      assert.equal(receiver.requests.length, 1);
      const payload = JSON.parse(receiver.requests[0].body);
      assert.equal(payload.event, 'license.expiring_soon');
      assert.equal(payload.license.companyName, 'Soon Co');
      assert.equal(payload.details.daysLeft, 7);

      // Second sweep: same expiry date, no duplicate reminder.
      await webhooks.sweepExpiring(store);
      await webhooks.idle();
      assert.equal(receiver.requests.length, 1);
    } finally {
      await receiver.close();
    }
  });

  // ---------- metrics ----------

  it('hides /metrics when METRICS_TOKEN is unset and gates it when set', async () => {
    await startServer();
    seedLicense({
      seatCap: 5,
      activations: [{ machineId: 'm1', machineName: 'Mac', activatedAt: Date.now(), lastSeenAt: Date.now() }],
    });

    const hidden = await get('/metrics', adminHeaders());
    assert.equal(hidden.status, 404);

    process.env.METRICS_TOKEN = METRICS_TOKEN;
    const wrong = await get('/metrics', adminHeaders('nope'));
    assert.equal(wrong.status, 401);

    const ok = await get('/metrics', adminHeaders(METRICS_TOKEN));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/plain/);
    assert.match(ok.text, /asktoto_licenses_total 1\n/);
    assert.match(ok.text, /asktoto_licenses_active 1\n/);
    assert.match(ok.text, /asktoto_seat_cap_total 5\n/);
    assert.match(ok.text, /asktoto_seats_used_total 1\n/);
    assert.match(ok.text, /asktoto_uptime_seconds \d/);
  });

  // ---------- analytics ----------

  it('serves chart-ready analytics behind admin auth', async () => {
    await startServer();
    const now = Date.now();
    seedLicense({
      seatCap: 5,
      activations: [
        { machineId: 'm1', machineName: 'Mac', activatedAt: now, lastSeenAt: now },
        { machineId: 'm2', machineName: 'Win', activatedAt: now - 40 * DAY_MS, lastSeenAt: now },
      ],
    });
    seedLicense({ licenseKey: 'ATK-0000000000000000BIG0', companyName: 'Big Co', seatCap: 10, activations: [] });

    const noAuth = await get('/admin/analytics');
    assert.equal(noAuth.status, 401);

    const { status, json } = await get('/admin/analytics', adminHeaders());
    assert.equal(status, 200);
    assert.equal(json.activationsByDay.length, 30);
    // Find the seeded day's bucket rather than assuming it's the last one — the UTC day can
    // roll over between seeding and the request.
    const seededDay = new Date(now).toISOString().slice(0, 10);
    const bucket = json.activationsByDay.find((d) => d.day === seededDay);
    assert.ok(bucket, 'seeded day present in the window');
    assert.equal(bucket.count, 1); // the 40-day-old activation is outside the window
    const totalCounted = json.activationsByDay.reduce((sum, d) => sum + d.count, 0);
    assert.equal(totalCounted, 1);

    // Sorted by seats used, then cap — Acme (2 seats held, only 1 activated this window)
    // before Big Co (0 used). An old activation still HOLDS a seat; only the timeline ages out.
    assert.equal(json.seatUtilization[0].companyName, 'Acme Corp');
    assert.equal(json.seatUtilization[0].seatsUsed, 2);
    assert.equal(json.seatUtilization[1].companyName, 'Big Co');
  });

  // ---------- server-side license-gate flags (LICENSE_ENFORCEMENT / LICENSE_UI_ENABLED) ----------
  // These are the SERVER's declaration of intent for the two client-side compile-time switches
  // (App.tsx's LICENSE_ENFORCEMENT, Settings.tsx's LICENSE_UI_ENABLED). The client wiring itself is
  // out of scope for this phase — these tests only cover the server's resolution + exposure of the
  // pair, including the plan's "flip both together" invariant.

  it('resolveLicenseGateConfig defaults both flags to false when neither env var is set', () => {
    const config = resolveLicenseGateConfig({});
    assert.deepEqual(config, { licenseEnforcement: false, licenseUiEnabled: false, drift: false });
  });

  it('resolveLicenseGateConfig mirrors a single set flag onto the other (one knob turns both on)', () => {
    const enforcementOnly = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'true' });
    assert.deepEqual(enforcementOnly, { licenseEnforcement: true, licenseUiEnabled: true, drift: false });

    const uiOnly = resolveLicenseGateConfig({ LICENSE_UI_ENABLED: '1' });
    assert.deepEqual(uiOnly, { licenseEnforcement: true, licenseUiEnabled: true, drift: false });
  });

  it('resolveLicenseGateConfig accepts both flags agreeing, in either direction', () => {
    const bothOn = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'true', LICENSE_UI_ENABLED: 'true' });
    assert.deepEqual(bothOn, { licenseEnforcement: true, licenseUiEnabled: true, drift: false });

    const bothOff = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'false', LICENSE_UI_ENABLED: '0' });
    assert.deepEqual(bothOff, { licenseEnforcement: false, licenseUiEnabled: false, drift: false });
  });

  it('resolveLicenseGateConfig fails CLOSED and flags drift when the two switches disagree', () => {
    const enforceButHideUi = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'true', LICENSE_UI_ENABLED: 'false' });
    assert.deepEqual(enforceButHideUi, { licenseEnforcement: false, licenseUiEnabled: false, drift: true });

    const showUiButDontEnforce = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'false', LICENSE_UI_ENABLED: 'true' });
    assert.deepEqual(showUiButDontEnforce, { licenseEnforcement: false, licenseUiEnabled: false, drift: true });
  });

  it('resolveLicenseGateConfig treats an unrecognized value as unset rather than throwing', () => {
    const config = resolveLicenseGateConfig({ LICENSE_ENFORCEMENT: 'maybe' });
    assert.deepEqual(config, { licenseEnforcement: false, licenseUiEnabled: false, drift: false });
  });

  it('GET /license/config exposes the resolved flags, unauthenticated, reflecting live env vars', async () => {
    await startServer();

    const defaultResponse = await get('/license/config');
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(defaultResponse.json, { ok: true, licenseEnforcement: false, licenseUiEnabled: false, drift: false });

    const prevEnforcement = process.env.LICENSE_ENFORCEMENT;
    const prevUi = process.env.LICENSE_UI_ENABLED;
    try {
      process.env.LICENSE_ENFORCEMENT = 'true';
      process.env.LICENSE_UI_ENABLED = 'true';
      const enabledResponse = await get('/license/config');
      assert.deepEqual(enabledResponse.json, { ok: true, licenseEnforcement: true, licenseUiEnabled: true, drift: false });

      // A drifted pair must still resolve server-side (fail closed), never 500, and never serve
      // an inconsistent pair to a client that reads this endpoint.
      process.env.LICENSE_UI_ENABLED = 'false';
      const driftedResponse = await get('/license/config');
      assert.deepEqual(driftedResponse.json, { ok: true, licenseEnforcement: false, licenseUiEnabled: false, drift: true });
    } finally {
      if (prevEnforcement === undefined) delete process.env.LICENSE_ENFORCEMENT;
      else process.env.LICENSE_ENFORCEMENT = prevEnforcement;
      if (prevUi === undefined) delete process.env.LICENSE_UI_ENABLED;
      else process.env.LICENSE_UI_ENABLED = prevUi;
    }
  });

  it('computeAnalytics tolerates activation records missing activatedAt', () => {
    const licenses = [
      {
        licenseKey: 'ATK-X',
        companyName: 'Odd Co',
        seatCap: 2,
        revoked: false,
        activations: [{ machineId: 'm1' }, { machineId: 'm2', activatedAt: Date.now() }],
      },
    ];
    const analytics = computeAnalytics(licenses);
    const total = analytics.activationsByDay.reduce((sum, d) => sum + d.count, 0);
    assert.equal(total, 1);
    assert.equal(analytics.seatUtilization[0].seatsUsed, 2);
  });
});
