# License-lease production pubkey

Production public half is provisioned in pubkey.json (public only).
Shape: { "algorithm": "ed25519", "publicKey": "<base64url>" }
Must not equal the DEV placeholder in src/main/license-lease-key.ts.
Copy from GET /license/pubkey on the license server.
Packaged builds refuse the DEV fallback.
