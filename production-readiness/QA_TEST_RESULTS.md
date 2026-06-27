# AskToto — QA Test Results (evidence)

Run date: 2026-06-27 · Host: macOS (darwin 27.0.0), Node via repo toolchain · All commands run from repo root.

## Gate summary

| Gate | Command | Result | Evidence |
|------|---------|--------|----------|
| Typecheck | `npm run typecheck` | **PASS** | exit 0, both `tsconfig.node.json` + `tsconfig.web.json`, no diagnostics |
| Unit tests | `npm test` (`vitest run`) | **PASS on real host (59/59)** | see below |
| Build | `npm run build` (`electron-vite build`) | **PASS** | exit 0, 3 bundles emitted (see artifacts) |
| Coverage | `npx vitest run --coverage` | captured | 21.13% stmts overall; critical logic high (see COVERAGE_REPORT.md) |
| Supply chain | `npm audit` | **27 vulns (16 high / 11 moderate / 0 critical)** | mostly dev toolchain |

## 1. Typecheck

```
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
(exit 0 — no output)
```

## 2. Unit tests

Real macOS host (keychain available), `npx vitest run`:

```
 Test Files  10 passed (10)
      Tests  59 passed (59)
```

Per-file: ipc.test.ts (10), routing.test.ts (9), store.test.ts (5), transcripts.test.ts (6),
personas.test.ts (4), graphify.test.ts (3), dustcli.test.ts (4), meeting-detect/shared.test.ts (4),
meeting-detect/win.test.ts (12), renderer/lib/consent.test.ts (4).

### Sandbox/keychain caveat (verified, not a code defect)
Under a sandbox that blocks keychain writes, `npm test` reported **3 failed / 56 passed**. All three
failures are in `dustcli.test.ts` and come from the OS, not the app:

```
FAIL src/main/dustcli.test.ts > imports token + workspace and maps EU region to eu.dust.tt
Error: Command failed: security add-generic-password -s asktoto-dustcli-test -a access_token -w tok_eu_123
security: SecKeychainItemCreateFromContent (<default>): UNIX[Operation not permitted]
```

Re-running the same file **outside** the sandbox: `PASS (4) FAIL (0)`. The "empty keychain" test passes
even sandboxed because it only *reads*. Registered in FLAKY_TEST_REGISTER.md.

## 3. Build artifacts (electron-vite, production)

```
out/main/index.js        107.34 kB
out/preload/index.js     118.41 kB
out/renderer/index.html    1.40 kB
  assets/index-*.js                3,730.85 kB   ← main renderer chunk
  assets/wasm-*.js                   622.45 kB
  assets/Settings-*.js               222.60 kB   ← lazy chunk
  assets/RecallView-*.js              11.90 kB   ← lazy chunk
  assets/Review-*.js                  10.35 kB   ← lazy chunk
  assets/whisper.worker-*.js       2,001.74 kB
  assets/ort-wasm-simd-threaded.jsep-*.wasm   21,596.02 kB   ← onnxruntime-web
  assets/index-*.css                  58.28 kB
  fonts inter 48.26 kB + geist 28.40 kB
✓ built in ~2s   (exit 0)
```

Lazy-loading confirmed: `Settings`, `Review`, `RecallView` are `React.lazy()`-split (App.tsx:8-10), so
they are not in the first-paint critical path. See PERFORMANCE_REPORT.md for analysis of the 3.7 MB
main chunk and the 21.6 MB WASM.

## 4. Coverage (v8) — headline

```
File            | % Stmts | % Branch | % Funcs | % Lines
All files       |   21.13 |   20.51  |  19.39  |  21.04
 routing.ts     |   96.29 |   92.85  |   100   |   100
 dustcli.ts     |   94.11 |   78.57  |   100   |  94.11
 prompts.ts     |    100  |    50    |   100   |   100
 transcripts.ts |   59.13 |   42.25  |  73.68  |    62
 store.ts       |    47.5 |   24.48  |  55.55  |  47.82
 personas.ts    |     40  |   52.38  |    75   |  47.05
 graphify.ts    |   34.31 |   23.64  |  34.37  |  33.33
 auth.ts        |      0  |     0    |     0   |     0
 index.ts(main) |      0  |     0    |     0   |     0
 llm.ts         |      0  |     0    |     0   |     0
 recall.ts      |      0  |     0    |     0   |     0
```

Interpretation in COVERAGE_REPORT.md: pure logic at the trust boundary is well covered; Electron-bound
files (IPC wiring, MSAL auth, streaming, recall, updater, platform-perms, preload, mac detector) are at
0% because they require an Electron runtime — partially exercised by the un-CI'd `selftest.ts` harness.

## 5. Supply chain — `npm audit`

```
vulnerabilities: { moderate: 11, high: 16, critical: 0, total: 27 }
dependencies:    { prod: 141, dev: 964, total: 1104 }
```

High/moderate counts are dominated by the **dev/build toolchain** (electron-builder, vite chain) which
is not shipped in the asar. No critical. `npm audit` is not yet a CI step — recommend adding it to the
`quality` job (non-blocking initially, then `--audit-level=high`).

## 6. In-Electron smoke harness (selftest.ts) — available, not run in CI
`ASKTOTO_SELFTEST=/path/out.json` boots Electron, runs ~20 assertions over real main logic (malformed
managed-config never crashes `getSettings`; tolerant settings migration; collision-safe transcript save
+ index + README + Dust frontmatter; `detectOneDrive`; `resolveModel`; injection guard present on
suggest/summary/recap; `ProviderIdSchema` rejects `../../etc/passwd`) and writes `{passed,total,results}`.
**Gap:** not part of `npm test`, not in `.github/workflows/build.yml` → its guarantees are unverified per build.

## 7. Defects found during this run
- D1 (MEDIUM, CI determinism): dustcli keychain tests fail in any keychain-less environment. See flaky register.
- D2 (LOW, test isolation): store/transcripts tests share a fixed userData path from the electron mock.
- D3 (MEDIUM, process): `selftest.ts` and `npm audit` are not wired into CI, so two of the strongest
  reliability checks never gate a release.
