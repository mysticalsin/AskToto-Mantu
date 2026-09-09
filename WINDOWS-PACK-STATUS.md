# Windows pack status (cloud agent)

## Blockers on this device

This Cursor cloud VM is **Linux**. The Windows pack chain is intentionally Windows-only (`scripts/check-build-host.mjs`): it builds, then **launches** `release/win-unpacked/Metis.exe` and runs real ASR. There is no override.

Additionally, this agent token cannot:

- `workflow_dispatch` (`HTTP 403`)
- `gh pr create` (`Resource not accessible by integration`)

So a fresh **1.8.9** (`origin/main`) installer cannot be produced from here.

## What was pushed

Branch: `cursor/windows-pack-latest-8ca3`  
Adds: `.github/workflows/unsigned-win-pack.yml` (manual unsigned pack on `windows-latest`, `git_ref` default `main`).

Compare: https://github.com/mysticalsin/AskToto-Mantu/compare/main...cursor/windows-pack-latest-8ca3?expand=1

## Verified on this device (artifact inspection only)

Downloaded draft release **v1.8.4** (newest Windows Setup/Portable currently on GitHub Releases; main package version is **1.8.9**):

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Metis-Portable-1.8.4.exe` | 766952628 | `2239d4b877901f1edd145ccb3338c776b8a27e4144e32f7e3687a4847554b801` |
| `Metis-Setup-1.8.4.exe` | 767305772 | `775b4b2403032b706829a6cdbf8fcb4524fa3df8ee970f4a7fcca02123df5326` |

Both are valid PE32 NSIS GUI executables (`file(1)` + MZ/PE parse). They were **not** launched here (no Windows / no Wine).

## Maintainer next step (packs latest main)

```bash
gh workflow run unsigned-win-pack.yml --ref cursor/windows-pack-latest-8ca3 -f git_ref=main
# or on a Windows box:
npm ci && npm run predist:win && npm run build:intelligence && npm run build
npx electron-builder --config electron-builder.win.yml --win --x64 --publish never
npm run dist:win
```
