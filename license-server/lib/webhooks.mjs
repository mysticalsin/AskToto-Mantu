// Outbound webhook notifications for license lifecycle events.
//
// When LICENSE_WEBHOOK_URL is set, the server POSTs a JSON event there for: license.created,
// license.revoked, license.unrevoked, license.deleted, store.restored, license.seat_limit (an
// /activate bounced off the seat cap), and license.expiring_soon (a periodic sweep). Point it at
// a Slack/Teams relay, n8n/Zapier, or any endpoint you own and the license business becomes
// something that TELLS you when it needs attention instead of waiting to be checked.
//
// Design constraints, in order:
//  1. NEVER slow down or fail the request being handled — dispatch is fire-and-forget behind a
//     promise-chain queue (same discipline as audit.mjs), with bounded retries.
//  2. Deliver in order — one queue, an event isn't attempted until the previous one settled.
//  3. Be verifiable — when LICENSE_WEBHOOK_SECRET is set, each delivery carries
//     X-AskToto-Signature: sha256=<hex HMAC of the raw body>, so the receiver can reject forgeries.
//  4. Don't spam — license.seat_limit fires at most once per license per hour (a capped-out
//     license bounces every launch of every extra machine), and license.expiring_soon fires once
//     per (license, expiry date) per process lifetime. The expiring-soon dedupe is in-memory, so
//     a server restart may repeat a reminder once — acceptable for a human-read alert channel.
import { createHmac } from 'node:crypto';

const RETRY_DELAYS_MS = [1_000, 5_000]; // attempt, then +1s, then +5s = 3 attempts total
const DELIVERY_TIMEOUT_MS = 5_000;
const SEAT_LIMIT_THROTTLE_MS = 60 * 60 * 1000;
const EXPIRY_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Discord webhook URLs speak Discord's own payload schema ({ content | embeds }), not ours — a
// generic JSON event gets rejected with 400 ("Cannot send an empty message") and dropped as
// terminal. Detect them and translate each event into a Discord embed, so pointing
// LICENSE_WEBHOOK_URL straight at a Discord channel just works, no relay needed.
const DISCORD_WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\//;

export function isDiscordWebhookUrl(url) {
  return DISCORD_WEBHOOK_RE.test(String(url || ''));
}

const DISCORD_EVENT_META = {
  'license.created': { title: 'License created', color: 0x34d399 },
  'license.revoked': { title: 'License revoked', color: 0xf87171 },
  'license.unrevoked': { title: 'License unrevoked', color: 0x34d399 },
  'license.deleted': { title: 'License deleted', color: 0xf87171 },
  'license.seat_limit': { title: 'Seat cap reached', color: 0xfbbf24 },
  'license.expiring_soon': { title: 'License expiring soon', color: 0xfbbf24 },
  'store.restored': { title: 'Store restored from backup', color: 0x9645d6 },
};

// A chat channel is a much leakier place than a signed webhook receiver — never post the full
// license key there. Enough to recognize it in the dashboard, not enough to activate with.
function truncateKey(key) {
  if (typeof key !== 'string' || key.length <= 13) return key || '';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export function formatDiscordPayload(event, at, payload) {
  const meta = DISCORD_EVENT_META[event] || { title: event, color: 0x9645d6 };
  const license = payload.license;
  const details = payload.details || {};
  const fields = [];
  if (license) {
    fields.push({ name: 'Company', value: String(license.companyName || '—'), inline: true });
    fields.push({ name: 'Seats', value: `${license.seatsUsed} / ${license.seatCap}`, inline: true });
    fields.push({
      name: 'Expires',
      value: license.expiresAt ? new Date(license.expiresAt).toISOString().slice(0, 10) : 'Never',
      inline: true,
    });
    fields.push({ name: 'Key', value: truncateKey(license.licenseKey), inline: true });
  }
  if (details.daysLeft !== undefined) fields.push({ name: 'Days left', value: String(details.daysLeft), inline: true });
  if (details.restoredCount !== undefined) fields.push({ name: 'Licenses restored', value: String(details.restoredCount), inline: true });
  return {
    username: 'AskToto Licenses',
    embeds: [
      {
        title: license ? `${meta.title} — ${license.companyName}` : meta.title,
        color: meta.color,
        fields,
        timestamp: new Date(at).toISOString(),
      },
    ],
  };
}

export function licenseEventView(license) {
  return {
    licenseKey: license.licenseKey,
    companyName: license.companyName,
    seatCap: license.seatCap,
    seatsUsed: license.activations.length,
    expiresAt: license.expiresAt,
    revoked: license.revoked,
  };
}

export function createWebhooks({ url, secret, expiryAlertDays = 14, fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  let queue = Promise.resolve();
  let sweepTimer = null;
  const seatLimitLastSent = new Map(); // licenseKey -> timestamp
  const expiryNotified = new Set(); // `${licenseKey}|${expiresAt}`

  const enabled = !!url;
  const discord = isDiscordWebhookUrl(url);

  async function deliver(body) {
    const headers = { 'content-type': 'application/json', 'user-agent': 'asktoto-license-server' };
    if (secret) {
      headers['x-asktoto-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
        try {
          const res = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
          if (res.ok) return true;
          // A 4xx is the receiver saying "I will never accept this" — retrying can't help.
          // EXCEPT 429 (rate-limited: retry-later by definition — exactly what Slack/Zapier
          // relays return during bursts) and 408 (request timeout): both are transient.
          if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) {
            console.warn(`[license-server] webhook rejected (HTTP ${res.status}); not retrying`);
            return false;
          }
          throw new Error(`HTTP ${res.status}`);
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.warn(`[license-server] webhook delivery failed after ${attempt + 1} attempts:`, err.message);
          return false;
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  // Fire-and-forget from the caller's perspective. Returns the queue promise so tests can await
  // deterministically (mirrors auditLog.record / store.persist).
  function emit(event, payload) {
    if (!enabled) return Promise.resolve();
    const at = Date.now();
    const body = discord
      ? JSON.stringify(formatDiscordPayload(event, at, payload))
      : JSON.stringify({ event, at, ...payload });
    queue = queue
      .then(
        () => deliver(body),
        () => deliver(body)
      )
      .catch((err) => {
        console.warn('[license-server] webhook queue error:', err);
      });
    return queue;
  }

  // Throttled wrapper for the one event that would otherwise fire on every app launch of every
  // over-cap machine.
  function emitSeatLimit(license) {
    if (!enabled) return Promise.resolve();
    const now = Date.now();
    const last = seatLimitLastSent.get(license.licenseKey);
    if (last !== undefined && now - last < SEAT_LIMIT_THROTTLE_MS) return Promise.resolve();
    seatLimitLastSent.set(license.licenseKey, now);
    return emit('license.seat_limit', { license: licenseEventView(license) });
  }

  // One pass over the store: every non-revoked license whose expiry falls within the alert
  // window (and hasn't already lapsed) gets one license.expiring_soon, deduped on the exact
  // expiry timestamp — so extending a license re-arms the reminder for its NEW date.
  function sweepExpiring(store) {
    if (!enabled) return Promise.resolve();
    const now = Date.now();
    const cutoff = now + expiryAlertDays * 24 * 60 * 60 * 1000;
    const emits = [];
    for (const license of store.getAll()) {
      if (license.revoked) continue;
      if (license.expiresAt === null || license.expiresAt === undefined) continue;
      if (license.expiresAt < now || license.expiresAt > cutoff) continue;
      const dedupeKey = `${license.licenseKey}|${license.expiresAt}`;
      if (expiryNotified.has(dedupeKey)) continue;
      expiryNotified.add(dedupeKey);
      emits.push(
        emit('license.expiring_soon', {
          license: licenseEventView(license),
          details: { daysLeft: Math.ceil((license.expiresAt - now) / (24 * 60 * 60 * 1000)) },
        }).then((delivered) => {
          // emit resolves with deliver()'s boolean. If the receiver was down through every retry,
          // re-arm the dedupe so the NEXT sweep tries again — otherwise a 20-second receiver
          // outage would permanently silence this license's renewal alert.
          if (delivered !== true) expiryNotified.delete(dedupeKey);
        })
      );
    }
    return Promise.all(emits);
  }

  function startExpirySweep(store) {
    if (!enabled || sweepTimer) return;
    sweepExpiring(store);
    sweepTimer = setInterval(() => sweepExpiring(store), EXPIRY_SWEEP_INTERVAL_MS);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  // Mirrors store.idle(): resolves once every emit enqueued so far has settled.
  function idle() {
    return queue;
  }

  return { enabled, emit, emitSeatLimit, sweepExpiring, startExpirySweep, stop, idle };
}
