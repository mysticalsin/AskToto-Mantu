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
