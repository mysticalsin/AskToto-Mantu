// License key generation + status helpers, shared by app.mjs.
import { randomBytes } from 'node:crypto';

// Crockford base32 alphabet: excludes I, L, O, U to avoid visual ambiguity.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// 256 % 32 === 0, so `byte % 32` is exactly uniform over the alphabet with
// no modulo bias — no rejection sampling needed.
export function generateLicenseKey() {
  const bytes = randomBytes(20);
  let suffix = '';
  for (let i = 0; i < bytes.length; i += 1) {
    suffix += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return `ATK-${suffix}`;
}

// Priority order matters: invalid > revoked > expired.
export function licenseStatus(license) {
  if (!license) return 'invalid';
  if (license.revoked) return 'revoked';
  if (license.expiresAt !== null && license.expiresAt !== undefined && license.expiresAt < Date.now()) {
    return 'expired';
  }
  return 'ok';
}

export function successPayload(license) {
  return {
    ok: true,
    companyName: license.companyName,
    seatCap: license.seatCap,
    seatsUsed: license.activations.length,
    expiresAt: license.expiresAt,
  };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Renewal-conversation signal: how many activated machines have phoned home
// (activate or heartbeat) within the last 30 days.
function countActiveSeats30d(license) {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  return license.activations.filter((a) => a.lastSeenAt >= cutoff).length;
}

// Admin list view: intentionally omits the raw activations/machineId list,
// and contactEmail/notes (detail-only — see adminDetailView below).
// contactName/etc default to '' for licenses minted before these fields
// existed; the on-disk record itself is never migrated to add them.
export function adminListView(license) {
  return {
    licenseKey: license.licenseKey,
    companyName: license.companyName,
    seatCap: license.seatCap,
    seatsUsed: license.activations.length,
    activeSeats30d: countActiveSeats30d(license),
    revoked: license.revoked,
    expiresAt: license.expiresAt,
    createdAt: license.createdAt,
    contactName: license.contactName || '',
    // Trial licenses (POST /admin/licenses/trial) are real, server-issued keys — this just lets
    // the dashboard/CSV/analytics tell them apart from sold licenses. Absent on every license
    // minted before this field existed; the on-disk record is never migrated to add it.
    trial: license.trial === true,
  };
}

// Admin detail view: full record, including activations and the metadata
// fields the list view leaves out.
export function adminDetailView(license) {
  return {
    ...adminListView(license),
    contactEmail: license.contactEmail || '',
    notes: license.notes || '',
    activations: license.activations,
  };
}

// How far ahead "expiring soon" looks, for the /admin/stats dashboard summary.
const EXPIRING_SOON_WINDOW_MS = THIRTY_DAYS_MS;

// Single-pass aggregate over every license, backing GET /admin/stats. Deliberately one loop (no
// separate .filter()/.reduce() passes) so the cost stays O(n) over the license list regardless of
// how many stat fields are derived from it — no N+1 lookups, nothing re-scans the activations array
// beyond the one countActiveSeats30d() call per license it already needs.
//
// Note the three license-status counters are independent predicates, not a 3-way partition:
// revokedLicenses counts every revoked license (whether or not it's also past its expiry), and
// expiredLicenses counts every license whose expiresAt has passed (whether or not it's also
// revoked) — only activeLicenses requires *both* "not revoked" and "not expired". A license that is
// both revoked and expired is counted in both revokedLicenses and expiredLicenses, but not active.
// How many trailing UTC days the analytics activation timeline covers.
const ANALYTICS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Chart-ready aggregates behind GET /admin/analytics. Two shapes:
//  - activationsByDay: one entry per UTC day for the last 30 days INCLUDING zero-count days
//    (a chart with holes where nothing happened reads as broken, not quiet).
//  - seatUtilization: every license's used/cap pair, sorted by seats used — the dashboard
//    truncates for display; the API returns all so nothing is silently hidden.
export function computeAnalytics(licenses, now = Date.now()) {
  const dayCounts = new Map();
  const todayStart = Date.parse(`${utcDayKey(now)}T00:00:00.000Z`);
  for (let i = ANALYTICS_DAYS - 1; i >= 0; i -= 1) {
    dayCounts.set(utcDayKey(todayStart - i * DAY_MS), 0);
  }

  const seatUtilization = [];
  for (const license of licenses) {
    for (const activation of license.activations) {
      // store.mjs validates activations is an array, not each entry's fields — a record restored
      // from an old/foreign backup may lack activatedAt or carry garbage. Number.isFinite alone
      // isn't enough: a finite ms value beyond ±8.64e15 still makes toISOString() throw.
      const activatedDate = new Date(activation.activatedAt);
      if (typeof activation.activatedAt !== 'number' || Number.isNaN(activatedDate.getTime())) continue;
      const key = activatedDate.toISOString().slice(0, 10);
      if (dayCounts.has(key)) dayCounts.set(key, dayCounts.get(key) + 1);
    }
    seatUtilization.push({
      licenseKey: license.licenseKey,
      companyName: license.companyName,
      seatsUsed: license.activations.length,
      seatCap: license.seatCap,
      revoked: license.revoked,
    });
  }
  seatUtilization.sort((a, b) => b.seatsUsed - a.seatsUsed || b.seatCap - a.seatCap);

  return {
    activationsByDay: Array.from(dayCounts, ([day, count]) => ({ day, count })),
    seatUtilization,
  };
}

export function computeStats(licenses) {
  const now = Date.now();
  const soonCutoff = now + EXPIRING_SOON_WINDOW_MS;

  let totalLicenses = 0;
  let activeLicenses = 0;
  let revokedLicenses = 0;
  let expiredLicenses = 0;
  let totalSeatCap = 0;
  let totalSeatsUsed = 0;
  let totalActive30d = 0;
  const expiringSoon = [];

  for (const license of licenses) {
    totalLicenses += 1;
    totalSeatCap += license.seatCap;
    totalSeatsUsed += license.activations.length;
    totalActive30d += countActiveSeats30d(license);

    const hasExpiry = license.expiresAt !== null && license.expiresAt !== undefined;
    // Exclusive (< now), matching licenseStatus() which is the authoritative gate used by /activate and
    // /heartbeat — otherwise at the exact expiry millisecond the app would still activate while the
    // dashboard counted the license expired.
    const isExpired = hasExpiry && license.expiresAt < now;

    if (license.revoked) revokedLicenses += 1;
    if (isExpired) expiredLicenses += 1;
    if (!license.revoked && !isExpired) activeLicenses += 1;

    if (!license.revoked && !isExpired && hasExpiry && license.expiresAt <= soonCutoff) {
      expiringSoon.push({
        licenseKey: license.licenseKey,
        companyName: license.companyName,
        expiresAt: license.expiresAt,
      });
    }
  }

  expiringSoon.sort((a, b) => a.expiresAt - b.expiresAt);

  return {
    totalLicenses,
    activeLicenses,
    revokedLicenses,
    expiredLicenses,
    totalSeatCap,
    totalSeatsUsed,
    totalActive30d,
    expiringSoon,
  };
}
