# Operator skill production pubkey

Place pubkey.json here before check:release.
Shape: { "algorithm": "ed25519", "publicKey": "<base64url>" }
Must not equal the DEV placeholder in src/main/operator-skill-key.ts.
See operator/README.md for how to derive the public half.
Packaged builds refuse the DEV fallback.
