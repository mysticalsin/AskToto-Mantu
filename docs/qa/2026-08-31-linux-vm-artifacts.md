# Linux VM packaging evidence — 31 Aug 2026

Fail-closed. Every claim below is a command + exit_code + path.

Worker is **not** Totos-Mac. Combined local show tree `45a1139` is not in this clone. Electron was not opened there. No installer pack on Tony's Mac. Live `listwins` was not run.

## Product on `main`

`main` is `9dbcd2d`: overlay chrome **58** plus upgrades **62–69** as one product.

```
command: git log -1 --oneline origin/main
exit_code: 0
```

58 Hide 8×2 + Island hover is **not frozen**. Mac-test on this Linux VM is the vitest proof (`mac-hide-island.proof.test.ts` + geometry + cursor-watch), not Totos-Mac `listwins`.

66 and 68 stay **in flight** as their own PRs (base `main`). Unique extras were **ported** onto this tree. Their heads were **not** merged (those heads still carry old 58 history).

```
command: gh pr view 66 --json baseRefName && gh pr view 68 --json baseRefName
exit_code: 0
```

| PR | head | base | note |
| --- | --- | --- | --- |
| https://github.com/mysticalsin/AskToto-Mantu/pull/66 | `cursor/onboarding-starfield-bed-5dc8` | `main` | extras ported; do not merge head |
| https://github.com/mysticalsin/AskToto-Mantu/pull/68 | `cursor/bar-pill-jarvis-orb-a612` | `main` | extras ported; do not merge head |

## Tests

```
command: npm test
exit_code: 0
path: /opt/cursor/artifacts/npm-test-58-62-69.log
```

331 files, 4060 passed, 18 skipped. Proxy: 28 passed.

```
command: npm run typecheck && npm run check:bugs
exit_code: 0
```

typecheck OK (30 known test-type errors at baseline). check:bugs OK (284 tracked, 280 FIXED, 2 OPEN).

## Host

```
command: uname -a
exit_code: 0
path: /opt/cursor/artifacts/darwin-host-probe.log
```

```
Linux cursor 6.12.94+ #1 SMP PREEMPT_DYNAMIC Fri Aug 28 16:08:20 UTC 2026 x86_64 GNU/Linux
hostname=cursor
process.platform=linux
```

## Mac DMG + native LSUIElement `.app` — BLOCKED

Darwin tools are absent on this host.

```
command: command -v hdiutil; command -v swiftc; command -v codesign; command -v xcrun; command -v lipo
exit_code: 1 (all missing)
path: /opt/cursor/artifacts/darwin-host-probe.log
```

Do not fake a DMG. Devon owns Verifier.

Three real paths if a Mac appears:

1. Tony Mac **Totos-Mac.local**
2. A **Mac cloud pool** once a team exists
3. **Unsigned zip** as last: build on a Mac, then `listwins` on Totos-Mac

## `npm run dist:win` — REFUSED (no override)

```
command: node scripts/check-build-host.mjs win
exit_code: 1
```

Packaged launch and packaged ASR were **not** run. wine is not Windows.

## Linux installer — BLOCKED by product policy

`scripts/after-pack.mjs` throws if the target is not mac/win.

## Windows EXE (cross-compile on this Linux VM)

Rebuilt on the combined `9dbcd2d` tree (app version **1.8.0**).

```
command: npx electron-builder --config electron-builder.win.yml --win --x64 --publish never
exit_code: 0
path: /opt/cursor/artifacts/electron-builder-win.log
```

afterPack: `[check:packaged-runtime] OK win (pre-sign)`.

`release/` is gitignored and each installer is **882 MB** (GitHub blob limit 100 MB). The binaries stay on this VM. sha256 is what is git-visible.

```
command: sha256sum release/Metis-Setup-1.8.0.exe release/Metis-Portable-1.8.0.exe release/win-unpacked/Metis.exe
exit_code: 0
path: /opt/cursor/artifacts/win-exe-1.8.0.sha256
```

| path | size | sha256 |
| --- | --- | --- |
| `/workspace/release/Metis-Setup-1.8.0.exe` | 882M | `fb666be77e9b5891e9aeee6020c210c4f39e32192d04093d5512c6b788d4ce8c` |
| `/workspace/release/Metis-Portable-1.8.0.exe` | 882M | `51a84072da54600a05a0229f4eb08fbda5c28ee3e25803251a3c1ad7e6f4d71e` |
| `/workspace/release/win-unpacked/Metis.exe` | 202M | `c7973372b3f080f7d7cb0b5b38052ad1b5eaf41ac135b7163b391092c2f88fe6` |

Not launch-proved. Not ASR-proved. Not signed for customers.

## Upgrades commit

Branch `cursor/land-upgrades-62-69-acda` landed on `main` at `9dbcd2d`.
