import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { generateLicenseKey, licenseStatus, successPayload, adminListView, adminDetailView } from './license.mjs';

const MAX_ID_LEN = 200;
const idString = z.string().trim().min(1).max(MAX_ID_LEN);

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
});

const adminPatchSchema = z
  .object({
    seatCap: z.number().int().positive().optional(),
    expiresAt: z.number().int().nonnegative().nullable().optional(),
  })
  .refine((body) => body.seatCap !== undefined || body.expiresAt !== undefined, {
    message: 'at least one of seatCap or expiresAt must be provided',
  });

function badRequest(res, parseResult) {
  return res.status(400).json({
    ok: false,
    error: 'invalid_request',
    details: parseResult.error.flatten(),
  });
}

// Builds the Express app around a given store. Kept as a factory (rather
// than a module-level singleton) so tests can spin up isolated instances
// against isolated temp-file stores.
export function createApp(store) {
  const app = express();
  app.use(express.json());

  // JSON body parse errors land here (thrown by express.json()).
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    return next(err);
  });

  app.post('/activate', (req, res) => {
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
      return res.json(successPayload(license));
    }

    if (license.activations.length >= license.seatCap) {
      return res.json({ ok: false, error: 'seat_limit_reached' });
    }

    license.activations.push({
      machineId,
      machineName: machineName || '',
      activatedAt: now,
      lastSeenAt: now,
    });
    store.persist();
    return res.json(successPayload(license));
  });

  app.post('/heartbeat', (req, res) => {
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
    return res.json(successPayload(license));
  });

  app.post('/deactivate', (req, res) => {
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
    return res.json({ ok: true });
  });

  function requireAdmin(req, res, next) {
    const token = process.env.LICENSE_ADMIN_TOKEN;
    if (!token) {
      return res.status(503).json({
        ok: false,
        error: 'admin_disabled',
        message: 'LICENSE_ADMIN_TOKEN is not set on this server — admin routes are disabled until it is configured.',
      });
    }
    const header = req.get('authorization') || '';
    const [scheme, value] = header.split(' ');
    // timingSafeEqual so response time never leaks how much of the token matched. Both sides are
    // hashed first because timingSafeEqual requires equal-length buffers (a raw length check would
    // itself leak the token's length).
    const a = createHash('sha256').update(String(value || '')).digest();
    const b = createHash('sha256').update(token).digest();
    if (scheme !== 'Bearer' || !value || !timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return next();
  }

  app.post('/admin/licenses', requireAdmin, (req, res) => {
    const parsed = adminCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);
    const { companyName, seatCap, expiresAt } = parsed.data;

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
    };
    store.addLicense(license);

    return res.status(201).json({
      licenseKey: license.licenseKey,
      companyName: license.companyName,
      seatCap: license.seatCap,
      expiresAt: license.expiresAt,
    });
  });

  app.get('/admin/licenses', requireAdmin, (req, res) => {
    res.json(store.getAll().map(adminListView));
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
    return res.json(adminDetailView(license));
  });

  app.post('/admin/licenses/:key/unrevoke', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });
    license.revoked = false;
    store.persist();
    return res.json(adminDetailView(license));
  });

  app.patch('/admin/licenses/:key', requireAdmin, (req, res) => {
    const license = store.findByKey(req.params.key);
    if (!license) return res.status(404).json({ ok: false, error: 'not_found' });

    const parsed = adminPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed);

    if (parsed.data.seatCap !== undefined) license.seatCap = parsed.data.seatCap;
    if (parsed.data.expiresAt !== undefined) license.expiresAt = parsed.data.expiresAt;
    store.persist();
    return res.json(adminDetailView(license));
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true });
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
