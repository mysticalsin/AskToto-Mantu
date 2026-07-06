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

// Admin list view: intentionally omits the raw activations/machineId list.
export function adminListView(license) {
  return {
    licenseKey: license.licenseKey,
    companyName: license.companyName,
    seatCap: license.seatCap,
    seatsUsed: license.activations.length,
    revoked: license.revoked,
    expiresAt: license.expiresAt,
    createdAt: license.createdAt,
  };
}

// Admin detail view: full record, including activations.
export function adminDetailView(license) {
  return {
    ...adminListView(license),
    activations: license.activations,
  };
}
