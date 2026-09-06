import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { generateLicenseKey, licenseStatus, successPayload, adminListView, adminDetailView, computeStats, computeAnalytics } from './license.mjs';
import { licenseEventView } from './webhooks.mjs';
import { toCsv } from './csv.mjs';
import { signLease } from './lease.mjs';
import { resolveLicenseGateConfig } from './license-gate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read once at startup (module load), not per-request — the page is static
// and identical for every request, so there's no reason to hit the
// filesystem on every GET /admin/ui.
const ADMIN_UI_HTML = readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');

// Also read once at module load, for GET /health's `version` field — same reasoning as ADMIN_UI_HTML.
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

const MAX_ID_LEN = 200;
const MAX_NOTES_LEN = 2000;
const AUDIT_DEFAULT_LIMIT = 200;
const AUDIT_MAX_LIMIT = 1000;
const idString = z.string().trim().min(1).max(MAX_ID_LEN);
const contactNameField = z.string().trim().max(MAX_ID_LEN).optional();
const contactEmailField = z.string().trim().max(MAX_ID_LEN).optional();
const notesField = z.string().trim().max(MAX_NOTES_LEN).optional();

const activateSchema = z.object({
  licenseKey: idString,
  machineId: idString,
  machineName: z.string().max(MAX_ID_LEN).optional(),
});

const heartbeatSchema = z.object({
  licenseKey: idString,
  machineId: idString,
});

const deactivateSchema = z.object({
  licenseKey: idString,
  machineId: idString,
});

const adminCreateSchema = z.object({
  companyName: z.string().trim().min(1).max(MAX_ID_LEN),
  seatCap: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative().nullable().optional(),
  contactName: contactNameField,
  contactEmail: contactEmailField,
  notes: notesField,
});

// Trial keys are minted, not sold — no price, no checkout. Defaults mirror the plan's Phase 4
// language ("mints a 1-seat, N-day-expiry key (default 14) with notes: 'trial'").
const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_TRIAL_SEATS = 1;
const MAX_TRIAL_DAYS = 3650; // ~10 years — generous ceiling, still bounded (no accidental "forever")
const MAX_TRIAL_SEATS = 1000;

const adminTrialSchema = z.object({
  seats: z.number().int().positive().max(MAX_TRIAL_SEATS).optional(),
  days: z.number().int().positive().max(MAX_TRIAL_DAYS).optional(),
  companyName: z.string().trim().max(MAX_ID_LEN).optional(),
  contactName: contactNameField,
  contactEmail: contactEmailField,
  notes: notesField,
});

const adminPatchSchema = z
  .object({
    seatCap: z.number().int().positive().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
    contactName: contactNameField,
    contactEmail: contactEmailField,
    notes: notesField,
  })
  .refine(
    (body) =>
      body.seatCap !== undefined ||
      body.expiresAt !== undefined ||
      body.contactName !== undefined ||
      body.contactEmail !== undefined ||
      body.notes !== undefined,
    { message: 'at least one field must be provided' }
  );

function hashClientIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 16);
}

const HSTS = 'max-age=31536000; includeSubDomains';

function requestIsHttps(req) {
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return Boolean(req.secure || proto === 'https');
}

/** HSTS / nosniff / frame-deny on the HTTP surfaces. Not a Helmet kitchen-sink. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (requestIsHttps(req)) res.setHeader('Strict-Transport-Security', HSTS);
  next();
}

function badRequest(res, parseResult) {
  return res.status(400).json({
    ok: false,
    error: 'invalid_request',
    details: parseResult.error.flatten(),
  });
}

// Fixed-window rate limiter for the unauthenticated public endpoints (/activate, /heartbeat, /deactivate).
// Without it, anyone who learns a licenseKey can spam /activate with fresh random machineIds and burn
// every seat, locking out the real machines. Keyed on client IP + licenseKey so one noisy caller can't
// starve a different company's license. In-process (no dependency, no Redis) — correct for the single
// instance this is designed to run as; a horizontally-scaled deploy would move this to a shared store.
// Constructed PER app instance (state lives in the closure below), so it's isolated between servers.
const RL_WINDOW_MS = 60_000;
const RL_MAX = 20; // 20 activate/heartbeat calls per key+IP per minute — generous for real use, fatal to a seat-flood
function makeRateLimit() {
  const buckets = new Map();
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}|${(req.body && req.body.licenseKey) || ''}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now - b.start >= RL_WINDOW_MS) {
      buckets.set(key, { start: now, count: 1 });
    } else if (b.count >= RL_MAX) {
      // Attack log: route + IP only. The license key is the credential; it does not belong in stderr.
      const route = typeof req.path === 'string' && req.path ? req.path : 'unknown';
      console.warn(`[license-server] rate_limited route=${route} ip_hash=${hashClientIp(ip)}`);
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    } else {
      b.count += 1;
    }
    // Opportunistic sweep so the Map can't grow unbounded from unique keys over a long uptime.
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now - v.start >= RL_WINDOW_MS) buckets.delete(k);
    }
    return next();
  };
}

// Per-IP brute-force lockout for the admin bearer token — which, unlike /activate and /heartbeat, is
// the *entire* security model for every /admin/* route. Fixed-window counter of failed auth attempts,
// same shape as makeRateLimit above but a wholly separate closure/Map: different key (IP only, no
// licenseKey), different trigger (failed auth vs. call volume), different consequence (a hard lockout
// that a subsequently-correct token cannot buy out of, vs. just throttling). The two limiters never
// share state and so can never interfere with one another.
//
// Once an IP's failure count in the current window reaches ADMIN_LOCKOUT_MAX, every request from that
// IP gets 429 for the rest of the window — including one that supplies the *correct* token, so a
// leaked/guessed token doesn't let an attacker who's already tripped the lockout straight back in. A
// successful auth clears the IP's entry outright, resetting it for next time.
const ADMIN_LOCKOUT_WINDOW_MS = 15 * 60_000; // 15 minutes
const ADMIN_LOCKOUT_MAX = 10; // failed attempts from one IP within the window before lockout
function makeAdminLockout() {
  const buckets = new Map(); // ip -> { start, count }

  function bucketFor(ip, now) {
    const b = buckets.get(ip);
    if (!b || now - b.start >= ADMIN_LOCKOUT_WINDOW_MS) return null;
    return b;
  }

  return {
    isLocked(ip) {
      const now = Date.now();
      const b = bucketFor(ip, now);
      return !!b && b.count >= ADMIN_LOCKOUT_MAX;
    },
    recordFailure(ip) {
      const now = Date.now();
      let b = bucketFor(ip, now);
      if (!b) {
        b = { start: now, count: 0 };
        buckets.set(ip, b);
      }
      b.count += 1;
      // Opportunistic sweep so the Map can't grow unbounded from unique keys over a long uptime.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) if (now - v.start >= ADMIN_LOCKOUT_WINDOW_MS) buckets.delete(k);
      }
    },
    recordSuccess(ip) {
      buckets.delete(ip);
    },
  };
}

// A webhooks stand-in for when no webhook URL is configured (and for tests that don't care):
// every emit resolves immediately, nothing is delivered.
const NOOP_WEBHOOKS = {
  enabled: false,
  emit: () => Promise.resolve(),
  emitSeatLimit: () => Promise.resolve(),
};

// Builds the Express app around a given store + audit log. Kept as a
// factory (rather than a module-level singleton) so tests can spin up
// isolated instances against isolated temp-file stores.
//
// Default offline lease lifetime: how long a signed lease is valid for before the client must
// phone home again (a heartbeat well inside this window refreshes it). Kept short relative to the
// client's own 7-day soft-grace/30-day hard-cap fallback (src/main/license.ts) — the lease is a
// strictly *stronger* offline proof (a tampered or clock-rolled-back lease is rejected outright),
// not a longer one.
const DEFAULT_LEASE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// options.webhooks — a createWebhooks() instance (server.mjs wires the real one from env).
// options.backups — a createBackupManager() instance; without one the backup routes return 503.
// options.leaseSigningKey — { privateKey, publicKey, publicKeyRaw } from lease.mjs's
//   loadLeaseSigningKey(); undefined/null means LICENSE_LEASE_PRIVATE_KEY isn't set, so no lease is
//   ever issued and /license/pubkey 404s — every existing activate/heartbeat client is unaffected.
// options.leaseTtlMs — how long a freshly-issued lease is valid for; defaults to DEFAULT_LEASE_TTL_MS.
export function createApp(store, auditLog, options = {}) {
  const webhooks = options.webhooks || NOOP_WEBHOOKS;
  const backups = options.backups || null;
  const leaseSigningKey = options.leaseSigningKey || null;
  const leaseTtlMs = options.leaseTtlMs || DEFAULT_LEASE_TTL_MS;
  const app = express();
  const startedAt = Date.now();
  // Client-IP trust is deliberately OPT-IN via TRUST_PROXY, because the rate limiter and the admin
  // brute-force lockout both key on req.ip. Blanket-trusting X-Forwarded-For lets a DIRECTLY-reachable
  // server be fooled: an attacker rotates a spoofed XFF header to dodge both limiters. So:
  //  - Behind a reverse proxy (the deploy/ Caddy stack, Fly, nginx, Cloudflare) the server is NOT
  //    directly reachable and the proxy sets the real client IP in XFF — set TRUST_PROXY=1 so each
  //    customer is limited/locked-out independently (one hop; trusting only the nearest proxy).
  //  - Directly exposed (plain docker run -p, or LAN), leave it unset: req.ip is the real socket IP,
  //    which a remote client cannot spoof.
  const trustProxy = process.env.TRUST_PROXY;
  app.set('trust proxy', trustProxy === '1' || trustProxy === 'true' ? 1 : false);
  app.use(securityHeaders);
  app.use(express.json());
  const rateLimit = makeRateLimit();
  const adminLockout = makeAdminLockout();

  // Issues a signed, compact Ed25519 lease for a machine's current activation, or undefined when
  // no signing key is configured (additive-only: an old/unaware client simply never sees the field,
  // and a server operator who never sets LICENSE_LEASE_PRIVATE_KEY sees zero behaviour change).
  // The payload's `notAfter` is a signed absolute timestamp — moving the local clock backwards on
  // the machine can never extend it, unlike the wall-clock-only grace period this strictly improves.
  function issueLease(license, machineId) {
    if (!leaseSigningKey) return undefined;
    const issuedAt = Date.now();
    const payload = {
      licenseKey: license.licenseKey,
      machineId,
      companyName: license.companyName,
      seatCap: license.seatCap,
      issuedAt,
      notAfter: issuedAt + leaseTtlMs,
    };
    return signLease(payload, leaseSigningKey.privateKey);
  }

  // JSON body parse errors land here (thrown by express.json()).
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    return next(err);
  });

  app.post('/activate', rateLimit, (req, res) => {
    const parsed = activateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { licenseKey, machineId, machineName } = parsed.data;

    const license = store.findByKey(licenseKey);
    const status = licenseStatus(license);
    if (status !== 'ok') {
      return res.json({ ok: false, error: status });
    }

    const now = Date.now();
    const existing = license.activations.find((a) => a.machineId === machineId);
    if (existing) {
      // Idempotent re-activation (e.g. app restart) — does not consume a seat.
      existing.lastSeenAt = now;
      if (machineName) existing.machineName = machineName;
      store.persist();
      return res.json({ ...successPayload(license), lease: issueLease(license, machineId) });
    }

    if (license.activations.length >= license.seatCap) {
      // Throttled inside emitSeatLimit — a capped-out fleet retries on every app launch.
      webhooks.emitSeatLimit(license);
      return res.json({ ok: false, error: 'seat_limit_reached' });
    }

    license.activations.push({
      machineId,
      machineName: machineName || '',
      activatedAt: now,
      lastSeenAt: now,
    });
    store.persist();
    return res.json({ ...successPayload(license), lease: issueLease(license, machineId) });
  });

  app.post('/heartbeat', rateLimit, (req, res) => {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { licenseKey, machineId } = parsed.data;

    const license = store.findByKey(licenseKey);
    const status = licenseStatus(license);
    if (status !== 'ok') {
      return res.json({ ok: false, error: status });
    }

    const existing = license.activations.find((a) => a.machineId === machineId);
    if (!existing) {
      return res.json({ ok: false, error: 'not_activated' });
    }

    existing.lastSeenAt = Date.now();
    store.persist();
    return res.json({ ...successPayload(license), lease: issueLease(license, machineId) });
  });

  app.post('/deactivate', rateLimit, (req, res) => {
    const parsed = deactivateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { licenseKey, machineId } = parsed.data;

    const license = store.findByKey(licenseKey);
    if (!license) {
      return res.json({ ok: false, error: 'not_found' });
    }

    const idx = license.activations.findIndex((a) => a.machineId === machineId);
    if (idx === -1) {
      return res.json({ ok: false, error: 'not_found' });
    }

    license.activations.splice(idx, 1);
    store.persist();
    // /deactivate itself needs no auth (the app frees its own seat), but the
    // dashboard's "free seat" button calls this same route with the admin
    // bearer token attached — distinguish the two in the audit trail.
    auditLog.record({
      action: isValidAdminToken(req) ? 'deactivate_admin' : 'deactivate',
      licenseKey,
      details: { machineId },
    });
    return res.json({ ok: true });
  });

  // timingSafeEqual so response time never leaks how much of the token matched. Both sides are
  // hashed first because timingSafeEqual requires equal-length buffers (a raw length check would
  // itself leak the token's length).
  function bearerMatches(req, token) {
    if (!token) return false;
    const header = req.get('authorization') || '';
    const [scheme, value] = header.split(' ');
    const a = createHash('sha256').update(String(value || '')).digest();
    const b = createHash('sha256').update(token).digest();
    return scheme === 'Bearer' && !!value && timingSafeEqual(a, b);
  }

  function isValidAdminToken(req) {
    return bearerMatches(req, process.env.LICENSE_ADMIN_TOKEN);
  }

  const SESSION_COOKIE = 'metis_admin_session';
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  const sessions = new Map();

  function parseCookieHeader(header) {
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
    return out;
  }

  function sessionCookieLine(id, req, maxAgeSec) {
    const parts = [`${SESSION_COOKIE}=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSec}`];
    if (req.secure || req.get('x-forwarded-proto') === 'https') parts.push('Secure');
    return parts.join('; ');
  }

  function sessionIdFromReq(req) {
    const raw = parseCookieHeader(req.get('cookie') || '')[SESSION_COOKIE];
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
    return raw;
  }

  function validSession(req) {
    const id = sessionIdFromReq(req);
    if (!id) return false;
    const sess = sessions.get(id);
    if (!sess || Date.now() >= sess.expiresAt) {
      if (sess) sessions.delete(id);
      return false;
    }
    return true;
  }

  function createSession() {
    const now = Date.now();
    for (const [id, sess] of sessions) {
      if (now >= sess.expiresAt) sessions.delete(id);
    }
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { expiresAt: now + SESSION_TTL_MS });
    return id;
  }

  function requireAdmin(req, res, next) {
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      // No token configured means every admin call is rejected regardless of what's presented — that's
      // a misconfiguration, not an attack, so it must never feed the brute-force lockout counter below.
      return res.status(503).json({
        ok: false,
        error: 'admin_disabled',
        message: 'LICENSE_ADMIN_TOKEN is not set on this server — admin routes are disabled until it is configured.',
      });
    }
    if (validSession(req)) return next();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (adminLockout.isLocked(ip)) {
      console.warn(`[license-server] admin_lockout ip_hash=${hashClientIp(ip)}`);
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    }
    if (!isValidAdminToken(req)) {
      adminLockout.recordFailure(ip);
      console.warn(`[license-server] admin_auth_failed ip_hash=${hashClientIp(ip)}`);
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    adminLockout.recordSuccess(ip);
    return next();
  }

  app.post('/admin/session', (req, res) => {
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      return res.status(503).json({
        ok: false,
        error: 'admin_disabled',
        message: 'LICENSE_ADMIN_TOKEN is not set on this server — admin routes are disabled until it is configured.',
      });
    }
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (adminLockout.isLocked(ip)) {
      console.warn(`[license-server] admin_lockout ip_hash=${hashClientIp(ip)}`);
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    }
    if (!isValidAdminToken(req)) {
      adminLockout.recordFailure(ip);
      console.warn(`[license-server] admin_auth_failed ip_hash=${hashClientIp(ip)}`);
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    adminLockout.recordSuccess(ip);
    const id = createSession();
    res.setHeader('Set-Cookie', sessionCookieLine(id, req, Math.floor(SESSION_TTL_MS / 1000)));
    return res.json({ ok: true });
  });

  app.get('/admin/session', (req, res) => {
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      return res.status(503).json({ ok: false, error: 'admin_disabled' });
    }
    if (validSession(req) || isValidAdminToken(req)) return res.json({ ok: true });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  });

  app.delete('/admin/session', (req, res) => {
    const id = sessionIdFromReq(req);
    if (id) sessions.delete(id);
    res.setHeader('Set-Cookie', sessionCookieLine('', req, 0));
    return res.json({ ok: true });
  });

  // Static admin dashboard. The page itself carries no secrets. The browser posts the admin
  // token once to /admin/session, which sets an httpOnly session cookie. Subsequent /admin/*
  // calls authenticate via that cookie or a Bearer token (CLI). Serving the HTML needs no auth.
  app.get('/admin/ui', (req, res) => {
    res.type('html').send(ADMIN_UI_HTML);
  });

  app.get('/admin', (req, res) => {
    res.redirect('/admin/ui');
  });

  app.post('/admin/licenses', requireAdmin, (req, res) => {
    const parsed = adminCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { companyName, seatCap, expiresAt, contactName, contactEmail, notes } = parsed.data;

    let licenseKey = generateLicenseKey();
    while (store.findByKey(licenseKey)) {
      licenseKey = generateLicenseKey();
    }

    const license = {
      licenseKey,
      companyName,
      seatCap,
      createdAt: Date.now(),
      expiresAt: expiresAt ?? null,
      revoked: false,
      activations: [],
      contactName: contactName ?? '',
      contactEmail: contactEmail ?? '',
      notes: notes ?? '',
    };
    store.addLicense(license);
    auditLog.record({
      action: 'create',
      licenseKey: license.licenseKey,
      details: { companyName, seatCap, expiresAt: license.expiresAt },
    });
    webhooks.emit('license.created', { license: licenseEventView(license) });

    return res.status(201).json({
      licenseKey: license.licenseKey,
      companyName: license.companyName,
      seatCap: license.seatCap,
      expiresAt: license.expiresAt,
    });
  });

  // Mints a time-boxed TRIAL license/lease — no purchase, no price, no checkout of any kind. A
  // thin wrapper over the same create path as POST /admin/licenses, so the audit log, webhooks,
  // and dashboard all pick a trial up for free: it's a real license record (server-issued, with a
  // real expiry), just pre-filled with trial-shaped defaults (1 seat, 14 days, notes: "trial") and
  // tagged `trial: true` so the dashboard/CSV/analytics can tell trials apart from sold licenses.
  // Still admin-authed — minting a key, even a free one, is an operator action, not a public route.
  app.post('/admin/licenses/trial', requireAdmin, (req, res) => {
    const parsed = adminTrialSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { seats, days, companyName, contactName, contactEmail, notes } = parsed.data;

    const seatCap = seats ?? DEFAULT_TRIAL_SEATS;
    const trialDays = days ?? DEFAULT_TRIAL_DAYS;
    const expiresAt = Date.now() + trialDays * 24 * 60 * 60 * 1000;

    let licenseKey = generateLicenseKey();
    while (store.findByKey(licenseKey)) {
      licenseKey = generateLicenseKey();
    }

    const license = {
      licenseKey,
      companyName: companyName || 'Trial',
      seatCap,
      createdAt: Date.now(),
      expiresAt,
      revoked: false,
      activations: [],
      contactName: contactName ?? '',
      contactEmail: contactEmail ?? '',
      notes: notes ?? 'trial',
      trial: true,
    };
    store.addLicense(license);
    auditLog.record({
      action: 'create_trial',
      licenseKey: license.licenseKey,
      details: { companyName: license.companyName, seatCap, expiresAt, days: trialDays },
    });
    webhooks.emit('license.created', { license: licenseEventView(license) });

    return res.status(201).json({
      licenseKey: license.licenseKey,
      companyName: license.companyName,
      seatCap: license.seatCap,
      expiresAt: license.expiresAt,
      trial: true,
    });
  });

  app.get('/admin/licenses', requireAdmin, (req, res) => {
    res.json(store.getAll().map(adminListView));
  });

  app.get('/admin/licenses.csv', requireAdmin, (req, res) => {
    const header = [
      'companyName',
      'licenseKey',
      'seatCap',
      'seatsUsed',
      'activeSeats30d',
      'revoked',
      'createdAt',
      'expiresAt',
      'contactName',
      'contactEmail',
    ];
    const rows = store.getAll().map((license) => {
      const detail = adminDetailView(license);
      return [
        detail.companyName,
        detail.licenseKey,
        detail.seatCap,
        detail.seatsUsed,
        detail.activeSeats30d,
        detail.revoked,
        new Date(detail.createdAt).toISOString(),
        detail.expiresAt !== null && detail.expiresAt !== undefined ? new Date(detail.expiresAt).toISOString() : '',
        detail.contactName,
        detail.contactEmail,
      ];
    });
    res.set('Content-Disposition', 'attachment; filename="licenses.csv"');
    res.type('csv').send(toCsv([header, ...rows]));
  });

  // Dashboard summary: one cheap pass over the store (see computeStats), no per-license round trips.
  app.get('/admin/stats', requireAdmin, (req, res) => {
    res.json(computeStats(store.getAll()));
  });

  // Chart-ready aggregates for the dashboard's Analytics tab (activation timeline + seat
  // utilization) — computed server-side in one pass so the page never needs the raw store.
  app.get('/admin/analytics', requireAdmin, (req, res) => {
    res.json(computeAnalytics(store.getAll()));
  });

  app.get('/admin/licenses/:key', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json(adminDetailView(license));
  });

  app.post('/admin/licenses/:key/revoke', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });
    license.revoked = true;
    store.persist();
    auditLog.record({ action: 'revoke', licenseKey: license.licenseKey, details: { companyName: license.companyName } });
    webhooks.emit('license.revoked', { license: licenseEventView(license) });
    return res.json(adminDetailView(license));
  });

  app.post('/admin/licenses/:key/unrevoke', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });
    license.revoked = false;
    store.persist();
    auditLog.record({ action: 'unrevoke', licenseKey: license.licenseKey, details: { companyName: license.companyName } });
    webhooks.emit('license.unrevoked', { license: licenseEventView(license) });
    return res.json(adminDetailView(license));
  });

  app.patch('/admin/licenses/:key', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });

    const parsed = adminPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);

    if (parsed.data.seatCap !== undefined) license.seatCap = parsed.data.seatCap;
    if (parsed.data.expiresAt !== undefined) license.expiresAt = parsed.data.expiresAt;
    if (parsed.data.contactName !== undefined) license.contactName = parsed.data.contactName;
    if (parsed.data.contactEmail !== undefined) license.contactEmail = parsed.data.contactEmail;
    if (parsed.data.notes !== undefined) license.notes = parsed.data.notes;
    store.persist();
    auditLog.record({ action: 'patch', licenseKey: license.licenseKey, details: parsed.data });
    return res.json(adminDetailView(license));
  });

  // Permanent removal — for mis-mints and test licenses only; a real customer offboarding should be
  // a REVOKE so the record stays visible. The audit line preserves the license snapshot, so even a
  // delete leaves a durable trace in audit.jsonl.
  app.delete('/admin/licenses/:key', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });
    auditLog.record({ action: 'delete', licenseKey: license.licenseKey, details: adminListView(license) });
    webhooks.emit('license.deleted', { license: licenseEventView(license) });
    store.removeLicense(license.licenseKey);
    return res.json({ ok: true });
  });

  app.get('/admin/audit', requireAdmin, async (req, res) => {
    const requested = Number(req.query.limit);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, AUDIT_MAX_LIMIT) : AUDIT_DEFAULT_LIMIT;
    const entries = await auditLog.readLast(limit);
    res.json(entries);
  });

  // Full-fidelity export of the ENTIRE store, exactly as persisted (every field, every activation).
  // This is the authoritative backup source - one call, exact state - so scripts/backup.mjs doesn't
  // have to reconstruct it from list+detail.
  app.get('/admin/export', requireAdmin, (req, res) => {
    res.json({ version: PACKAGE_VERSION, exportedAt: Date.now(), licenses: store.getAll() });
  });

  // Replace the entire store from a backup (disaster recovery / migration between servers). Before
  // touching anything it snapshots the CURRENT data to a timestamped .bak file next to the db, so a
  // restore can never destroy the existing licenses even if the operator restores the wrong file.
  // store.replaceAll rejects a malformed payload before mutating, so a bad body is a clean 400.
  app.post('/admin/restore', requireAdmin, (req, res) => {
    const body = req.body || {};
    const incoming = Array.isArray(body) ? body : body.licenses;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ ok: false, error: 'invalid_request', message: 'body must be { licenses: [...] } or a raw array' });
    }
    // Snapshot current state first (best-effort but logged) - the safety net for a wrong restore.
    let snapshotPath = null;
    try {
      const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-');
      snapshotPath = path.join(path.dirname(store.dbPath), `licenses.pre-restore-${stamp}.bak`);
      writeFileSync(snapshotPath, JSON.stringify(store.getAll(), null, 2), 'utf8');
    } catch (err) {
      console.warn('[license-server] could not write pre-restore snapshot:', err);
      snapshotPath = null;
    }
    let count;
    try {
      count = store.replaceAll(incoming);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    auditLog.record({ action: 'restore', licenseKey: '(all)', details: { restoredCount: count, snapshot: snapshotPath && path.basename(snapshotPath) } });
    webhooks.emit('store.restored', { details: { restoredCount: count } });
    return res.json({ ok: true, restoredCount: count, snapshot: snapshotPath && path.basename(snapshotPath) });
  });

  // ---- server-side backups (see lib/backups.mjs) ----
  // All three routes 503 when no backup manager was wired in (tests that don't care, or an
  // embedded use of createApp) — never silently pretend a backup happened.

  app.post('/admin/backup', requireAdmin, async (req, res) => {
    if (!backups) return res.status(503).json({ ok: false, error: 'backups_disabled' });
    try {
      // force: an operator clicking "Back up now" expects a fresh file even if nothing changed.
      const result = await backups.runBackupNow({ force: true });
      auditLog.record({ action: 'backup', licenseKey: '(all)', details: { file: result.name, licenseCount: result.count } });
      return res.json({ ok: true, file: result.name, licenseCount: result.count });
    } catch (err) {
      console.error('[license-server] on-demand backup failed:', err);
      return res.status(500).json({ ok: false, error: 'backup_failed' });
    }
  });

  app.get('/admin/backups', requireAdmin, async (req, res) => {
    if (!backups) return res.status(503).json({ ok: false, error: 'backups_disabled' });
    try {
      return res.json({ dir: backups.backupDir, files: await backups.listFiles() });
    } catch (err) {
      console.error('[license-server] could not list backups:', err);
      return res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // Download one snapshot. The name must match the exact generated-filename shape — that (plus a
  // basename identity check) is what makes ../-style path traversal impossible here.
  app.get('/admin/backups/:name', requireAdmin, (req, res) => {
    if (!backups) return res.status(503).json({ ok: false, error: 'backups_disabled' });
    const name = req.params.name;
    if (!backups.isSafeBackupName(name)) {
      return res.status(400).json({ ok: false, error: 'invalid_request' });
    }
    res.download(path.join(backups.backupDir, name), name, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ ok: false, error: 'not_found' });
      }
    });
  });

  // Prometheus-style metrics, so an uptime monitor or Grafana can watch the license business
  // without admin credentials. Deliberately OFF unless METRICS_TOKEN is set (404, same as any
  // unknown route, so an unconfigured server doesn't even reveal the endpoint exists); when set,
  // the scraper authenticates with `Authorization: Bearer <METRICS_TOKEN>` — a separate,
  // lower-privilege secret than the admin token (metrics read aggregate counts, never keys).
  app.get('/metrics', (req, res) => {
    const metricsToken = process.env.METRICS_TOKEN;
    if (!metricsToken) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!bearerMatches(req, metricsToken)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const stats = computeStats(store.getAll());
    const lines = [];
    const gauge = (metricName, help, value) => {
      lines.push(`# HELP ${metricName} ${help}`);
      lines.push(`# TYPE ${metricName} gauge`);
      lines.push(`${metricName} ${value}`);
    };
    gauge('asktoto_uptime_seconds', 'Seconds since the license server started.', (Date.now() - startedAt) / 1000);
    gauge('asktoto_licenses_total', 'Total licenses in the store.', stats.totalLicenses);
    gauge('asktoto_licenses_active', 'Licenses that are neither revoked nor expired.', stats.activeLicenses);
    gauge('asktoto_licenses_revoked', 'Revoked licenses.', stats.revokedLicenses);
    gauge('asktoto_licenses_expired', 'Licenses past their expiry date.', stats.expiredLicenses);
    gauge('asktoto_licenses_expiring_soon', 'Active licenses expiring within 30 days.', stats.expiringSoon.length);
    gauge('asktoto_seat_cap_total', 'Sum of seat caps across all licenses.', stats.totalSeatCap);
    gauge('asktoto_seats_used_total', 'Sum of activated seats across all licenses.', stats.totalSeatsUsed);
    gauge('asktoto_seats_active_30d', 'Activated seats seen in the last 30 days.', stats.totalActive30d);
    res.type('text/plain; version=0.0.4; charset=utf-8').send(`${lines.join('\n')}\n`);
  });

  // Reserved v1 offline-first JWS contract. Selling is closed: these routes are the
  // real interface and return activation_unavailable until LICENSE_ACTIVATION_OPEN
  // is flipped AND a minting key is wired. Do not invent a second license product.
  const v1ActivateSchema = z.object({
    licenseKey: idString,
    deviceIdHash: z.string().regex(/^[0-9a-f]{64}$/),
    appVersion: z.string().trim().min(1).max(64),
    os: z.string().trim().min(1).max(32),
  });
  const v1RegisterSchema = z.object({
    installId: z.string().uuid(),
    appVersion: z.string().trim().min(1).max(64),
    os: z.string().trim().min(1).max(32),
  });

  function v1Unavailable(res) {
    return res.status(503).json({ ok: false, error: 'activation_unavailable' });
  }

  app.post('/v1/licenses/activate', rateLimit, (req, res) => {
    const parsed = v1ActivateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    return v1Unavailable(res);
  });

  app.post('/v1/installs/register', rateLimit, (req, res) => {
    const parsed = v1RegisterSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    return v1Unavailable(res);
  });

  // Unauthenticated by design (the client needs it before it has anything to authenticate with —
  // there's no secret here, only a public verification key). 404s when LICENSE_LEASE_PRIVATE_KEY
  // isn't configured, same "unconfigured feature doesn't even reveal it exists" convention as
  // /metrics — a server that has never turned leases on shouldn't advertise a key nobody signs
  // with. `publicKey` is the raw 32-byte Ed25519 key, base64url-encoded (the JWK `x` value) — the
  // client reconstructs it with `crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x },
  // format: 'jwk' })`, no PEM/DER parsing, no new dependency on either side.
  app.get('/license/pubkey', (req, res) => {
    if (!leaseSigningKey) return res.status(404).json({ ok: false, error: 'lease_disabled' });
    return res.json({ ok: true, algorithm: 'ed25519', publicKey: leaseSigningKey.publicKeyRaw });
  });

  // Server-declared state of the two client-side compile-time switches (LICENSE_ENFORCEMENT /
  // LICENSE_UI_ENABLED) — see lib/license-gate.mjs for the drift-fails-closed contract. This is a
  // read-only DECLARATION for a future managed-config fetch to consume; it does not itself gate
  // anything on this server (every /activate, /heartbeat, /admin/* route behaves exactly as it
  // does today regardless of this response). Unauthenticated: it's operator-declared intent, not a
  // secret, and a pre-activation client needs to read it before it has an admin token.
  app.get('/license/config', (req, res) => {
    const { licenseEnforcement, licenseUiEnabled, drift } = resolveLicenseGateConfig();
    return res.json({ ok: true, licenseEnforcement, licenseUiEnabled, drift });
  });

  app.get('/health', (req, res) => {
    // Public liveness only. Fleet size lives on token-gated /metrics — do not advertise it here.
    res.json({
      ok: true,
      version: PACKAGE_VERSION,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
    });
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Final safety net for any handler that throws synchronously.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[license-server] unhandled error:', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  });

  return app;
}
