# Speech policy admission boundaries

The desktop speech identity gate and the shared licence verifier have different scopes.

## Issuer duration and verifier compatibility

[`parseOperatorLicenseDays`](../../src/shared/operator-license.ts) accepts integer durations from
1 through 365 days. `generateOperatorLicense` consumes that parser and sets `exp = iat + days * 86400`.
The desktop speech identity gate reuses this existing issuer maximum through
`OPERATOR_LICENSE_MAX_DAYS`; it rejects a duration longer than 365 days. This is a duration bound,
not a freshness interval: an old but currently valid licence within the bound remains eligible.

The shared `parseOperatorLicense` and `verifyOperatorLicense` functions retain their existing behavior.
In particular, the verifier checks the signature and expiry without imposing the issuer's duration
maximum. The desktop gate therefore admits a narrower set than the shared verifier. Compatibility
with independently or manually signed licences longer than 365 days is **unverified**. The issuer
contract supports the normal generation path; it does not establish a universal verification policy
for every possible signed licence. Rollout evidence must resolve any such issuance requirements.

The desktop check reads licence metadata; it does not replace server-side signature verification.
[`speech-policy-authority.test.ts`](../../src/main/speech-policy-authority.test.ts) retains the
issued-at `1` refusal and exercises actual issuer-generated 365-day licences, including one issued
364 days earlier, plus a duration one second over the maximum.

## Broker snapshot shape

[`speech-broker-policy.ts`](../../src/main/speech-broker-policy.ts) rejects unknown top-level fields
at its local verified-snapshot boundary. The shared wire parser remains unchanged. Upstream parsing
can strip unknown wire fields before a snapshot reaches this gate, and nested compatibility remains
unchanged. This check establishes neither raw-wire rejection nor signature authenticity on its own.
The broker tests retain the extra-property refusal and cover the legacy defaulted speech-pack field.

## Evidence limit

Source tests passing on hosted CI do not establish installed package security, encrypted-profile
upgrade compatibility, recovery or rollback. Those require evidence for the exact installed bytes.
