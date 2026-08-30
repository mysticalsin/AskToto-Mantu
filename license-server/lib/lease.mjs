// Ed25519 offline lease signing/verification, built entirely on Node's `node:crypto` — no new
// dependency. A lease is a short, self-contained proof that a machine was validly activated as of
// some moment, that the desktop app can verify WITHOUT calling the server, and whose `notAfter`
// cannot be extended by moving the local clock backwards (only a real signature from this server's
// private key can produce a longer-lived lease).
//
// Compact wire format: `<base64url(JSON payload)>.<base64url(signature)>` — a single string, safe
// to embed in a JSON response field or write to a local file, no further encoding needed.
//
// Key handling: Ed25519 has no separate hash step (`sign(null, ...)` / `verify(null, ...)` is the
// correct, documented Node API for it — see https://nodejs.org/api/crypto.html#sign-algorithm-data-key).
// The public key is exchanged as the raw 32-byte key from its JWK `x` field (base64url), which is
// the most compact, dependency-free way to embed it in the client — no PEM/DER parsing required
// there, just `crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })`.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const LEASE_ALGORITHM = 'ed25519';

// Generates a brand-new Ed25519 signing key pair — for first-time operator setup
// (`npm run lease:keygen`). Never called by the server at request time.
export function generateLeaseKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyRaw: publicKeyToRaw(publicKey),
  };
}

// Extracts the raw 32-byte public key as a base64url string (the JWK `x` field for an OKP/Ed25519
// key IS exactly that — no extra encoding step needed).
export function publicKeyToRaw(publicKey) {
  return publicKey.export({ format: 'jwk' }).x;
}

// Reconstructs a public KeyObject from the raw base64url form produced by publicKeyToRaw.
export function rawToPublicKey(raw) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

// Loads the server's Ed25519 signing key pair from an env var value (PEM-encoded PKCS8 private
// key). Accepts the PEM literally (real newlines) OR that same PEM base64-encoded as a single
// line — most secret managers / .env UIs mangle embedded newlines, so the base64-wrapped form is
// the friendlier default for deployment. Returns null when unset: leases are then simply never
// issued and every existing /activate, /heartbeat behaviour is unchanged (additive-only contract).
export function loadLeaseSigningKey(raw) {
  const value = raw === undefined ? process.env.LICENSE_LEASE_PRIVATE_KEY : raw;
  if (!value || !value.trim()) return null;
  let pem = value.trim();
  if (!pem.includes('BEGIN')) {
    pem = Buffer.from(pem, 'base64').toString('utf8');
  }
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, publicKeyRaw: publicKeyToRaw(publicKey) };
}

// Signs a lease payload (a plain JSON-serializable object shaped by the caller — licenseKey,
// machineId, issuedAt, notAfter, seatCap, companyName, ...). The signature covers the exact
// base64url-encoded payload bytes, so verifyLease can re-derive and compare byte-for-byte before
// ever trusting the parsed JSON.
export function signLease(payload, privateKey) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(payloadB64, 'utf8'), privateKey);
  return `${payloadB64}.${signature.toString('base64url')}`;
}

// Verifies + parses a compact lease token against a public key (a KeyObject, or the raw base64url
// string from publicKeyToRaw — either is accepted for caller convenience). Returns the parsed
// payload on success, or null on ANY failure: wrong shape, bad base64, signature mismatch, or
// unparseable JSON. Deliberately never throws on attacker-controlled input — callers get a single
// boolean-ish surface (`payload = verifyLease(...); if (!payload) { ...reject... }`).
export function verifyLease(token, publicKey) {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const key = typeof publicKey === 'string' ? rawToPublicKey(publicKey) : publicKey;

  let signature;
  try {
    signature = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (signature.length === 0) return null;

  let signatureValid;
  try {
    signatureValid = verify(null, Buffer.from(payloadB64, 'utf8'), key, signature);
  } catch {
    return null;
  }
  if (!signatureValid) return null;

  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}
