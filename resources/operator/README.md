# Operator skill production pubkey

Production public half is provisioned in pubkey.json (public only).
Shape: { "algorithm": "ed25519", "publicKey": "<base64url>" }
Must not equal the DEV placeholder in src/main/operator-skill-key.ts.
See operator/README.md for how to derive the public half.
Packaged builds refuse the DEV fallback.
