#!/usr/bin/env node
// One-time operator setup: generates a fresh Ed25519 key pair for offline lease signing.
//
// Usage:
//   node scripts/generate-lease-keypair.mjs
//
// Prints the PRIVATE key (base64-of-PEM, so it's a single line safe for most secret managers/.env
// UIs — set it as LICENSE_LEASE_PRIVATE_KEY on the server) and the PUBLIC key (raw base64url — bundle
// this into the desktop client so it can verify leases entirely offline; a public key needs no
// encryption, unlike the server's private key, which must never leave this output.)
import { generateLeaseKeyPair } from '../lib/lease.mjs';

function main() {
  const { privateKeyPem, publicKeyRaw } = generateLeaseKeyPair();
  const privateKeyBase64 = Buffer.from(privateKeyPem, 'utf8').toString('base64');

  console.log('\nEd25519 offline-lease key pair generated.\n');
  console.log('Set this on the license-server (keep it secret — never in the app bundle, never in git):\n');
  console.log(`  LICENSE_LEASE_PRIVATE_KEY=${privateKeyBase64}\n`);
  console.log('Bundle this into the desktop client (a public key needs no encryption):\n');
  console.log(`  ${publicKeyRaw}\n`);
  console.log('If the private key ever leaks, generate a new pair and re-deploy — leases are');
  console.log('short-lived (see LICENSE_LEASE_TTL_DAYS), so rotation is just "the next heartbeat".\n');
}

main();
