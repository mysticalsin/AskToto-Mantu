# Windows signing identity preflight

This is a manually dispatched certificate diagnostic, not a release. A pass means the configured identity passed the checks below on that disposable Windows runner at the reported source revision. It does not authorize publication or replace the real installer checks in `release.yml`.

## Scope and inputs

The workflow accepts only `workflow_dispatch` in `mysticalsin/AskToto-Mantu` on `refs/heads/main`. Its required `expected_sha` must be the exact 40-character reviewed main commit. Checkout reads current `main`; the supervisor compares checkout HEAD, GitHub's dispatch SHA, and the approved SHA before secrets are exposed and again before loading the identity. A changed main revision fails closed. The only token permission is `contents: read`; checkout credentials are not persisted.

The existing three secrets are used only in the final diagnostic step:

- `WIN_CSC_LINK`: raw base64-encoded PKCS#12/PFX, at most 65,536 characters including whitespace.
- `WIN_CSC_KEY_PASSWORD`: the PFX password, preserved as configured.
- `WIN_CSC_EXPECTED_SUBJECT`: the exact certificate subject or common name. Comparison is ordinal/case-sensitive, with outer whitespace trimmed, matching the existing artifact verifier's policy.

The actual configured format has not been inspected. URL, filesystem-path, data-URI and malformed-base64 inputs return `CREDENTIAL_FORMAT_UNSUPPORTED`. Nothing fetches a credential URL or writes a PFX file. This intentionally supports fewer input forms than electron-builder; a failure does not authorize changing secrets or weakening policy. Hardware-backed or external signing-service credentials need a separately reviewed facility.

## What is checked

The PowerShell probe loads the PKCS#12 collection with `X509KeyStorageFlags.EphemeralKeySet`; it fails rather than falling back to persistent key storage. Microsoft's API documents this flag as memory-only key loading. The probe disposes certificate/key/chain objects and clears the decoded byte array and its credential environment variables. This is not a claim that immutable .NET strings or every OS-managed memory copy can be securely erased. [Microsoft key-storage flags](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509keystorageflags?view=netframework-4.8.1)

The checks require:

- Exactly one certificate with a private key: zero or multiple private identities fail.
- Exact expected publisher and valid, ordered `NotBefore`/`NotAfter` dates at the check time.
- Explicit code-signing EKU `1.3.6.1.5.5.7.3.3`; when KeyUsage exists it must allow digital signatures.
- An accessible RSA or ECDSA private-key handle. No challenge, document, app or other payload is signed, and no private key is exported. Handle access alone is not proof a later Authenticode signing operation will succeed. [Microsoft private-key access API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.rsacertificateextensions.getrsaprivatekey?view=netframework-4.8.1)
- Standard Windows system chain trust, explicit code-signing application policy, online revocation excluding the root, and `NoFlag` verification. No custom trust roots, ignored errors or self-signed exceptions. PFX chain certificates are untrusted `ExtraStore` material, not installed roots. Unknown/offline revocation fails.

Each chain URL retrieval is bounded at 10 seconds, and the supervisor caps the entire PowerShell process at 60 seconds with a 4 KiB output bound. The separate local Git revision check is capped at 10 seconds. The manual job itself is capped at five minutes. [Microsoft URL-retrieval timeout](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509chainpolicy.urlretrievaltimeout?view=netframework-4.8.1)

No signing identity is imported into a persistent certificate store, no key is exported/persisted, and no explicit trust-store changes are made. Ordinary Windows chain building may maintain public-root state or revocation caches on the disposable runner. `DisableCertificateDownloads` is enabled when the managed runtime exposes it; Windows PowerShell 5 may lack it. Consequently this is **not** a guarantee of zero OS trust-state mutation or no network use. [Microsoft AIA-download policy](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.x509chainpolicy.disablecertificatedownloads), [Windows chain-engine behavior](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certgetcertificatechain)

The supervisor captures native output and emits only a fixed category, success boolean and reviewed revision. It never logs certificate values, publisher names, certificate URLs, passwords, raw subprocess output or exception messages. Secrets are passed through a minimal child environment, never arguments. There is no app build/download/signing, certificate artifact, upload or release action.

## Authorized execution

First land the reviewed workflow and helpers on main. GitHub requires a dispatchable workflow to exist on the default branch. Run the following only after the release owner authorizes this diagnostic, replacing the placeholder with the reviewed current-main SHA. Do not paste credentials into the command. [GitHub manual-dispatch behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

```sh
gh workflow run windows-signing-identity-preflight.yml \
  --repo mysticalsin/AskToto-Mantu --ref main \
  -f expected_sha=<reviewed-current-main-40-character-SHA>
```

An identity success is `{"ok":true,"code":"PASS","revision":"..."}` in the final step. `REVISION_ACCEPTED` only confirms the source guard, not certificate validity. Skipped jobs are not passes. Failures identify a fixed category such as `CERTIFICATE_LOAD_FAILED`, `PUBLISHER_MISMATCH`, `PRIVATE_KEY_AMBIGUOUS`, `CERTIFICATE_NOT_CURRENT`, `CODE_SIGNING_EKU_MISSING`, `PRIVATE_KEY_UNAVAILABLE`, `CHAIN_UNTRUSTED`, `CERTIFICATE_REVOKED`, `REVOCATION_UNAVAILABLE` or `PREFLIGHT_TIMEOUT`; investigate without dumping secret material or relaxing trust.

## Verification and remaining release gates

Run `node --test scripts/windows-signing-identity-preflight.test.mjs` without installing app dependencies. The normal Vitest suite also invokes it through the small `.test.ts` adapter. Synthetic tests exercise the supervisor, certificate-facts policy and workflow/security contracts. On Windows an additional credential-free smoke verifies PowerShell parsing and safe rejection of deliberately invalid non-certificate bytes before the secret-bearing step. That smoke is skipped on non-Windows hosts and does not prove a valid private-key/chain path.

Actual configured-certificate usability remains unverified until an authorized Windows run passes. A successful preflight still does not prove a timestamp authority, timestamped installer signature, SmartScreen reputation, final app build/install, Mac Developer ID/notarization, microphone/screen capture, or physical Mac/Windows workflows. `release.yml` and its expected-publisher plus trusted-timestamp artifact verification remain unchanged and mandatory; publication remains separately gated on product QA.
