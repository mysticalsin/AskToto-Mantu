# Site-license `sub: *` (design note — not implemented)

`src/main/license/jws.ts` accepts `claims.sub === '*'` as a device wildcard when verifying an offline
lease. That is an intentional **site-license / air-gap** shape: one signed blob can license every device
in an offline fleet without per-device activation.

**Held as design (Ultron inventory):** do not widen or gate this in code on this residual lane. When
enforcement flips on, treat `sub: *` as an explicit air-gap / site-license **opt-in** minted only by
operator tooling for known air-gapped deployments — never the default online activate path. Document the
opt-in in the license mint UI/CLI in the same change that flips `LICENSE_ENFORCEMENT`.

No D1 ALTER and no client gate change in this residual.
