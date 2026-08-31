# Linux VM packaging evidence — 31 Aug 2026

Fail-closed. Every claim below is a command + exit_code + path.

Worker is **not** Totos-Mac. Combined local show tree `45a1139` is not in this clone. Electron was not opened there. No installer pack on Tony's Mac. Overlay **PR 58 stays frozen** (OPEN draft, tip `33cf8ad`, tree matches `e6bc7bc`). READY TO MERGE: no. Do not grow or merge 58.

Land vehicle is **#70** (`cursor/land-upgrades-62-69-acda`) based on `main`. 62-69 only. No overlay-chrome / Hide / Island files in this tree vs main.

## 68 / 69 retarget

```
command: gh pr view 68 --json baseRefName && gh pr view 69 --json baseRefName
```

| PR | head | old base | new base |
| --- | --- | --- | --- |
| https://github.com/mysticalsin/AskToto-Mantu/pull/68 | `cursor/bar-pill-jarvis-orb-a612` | `cursor/overlay-chrome-island-f504` | `main` |
| https://github.com/mysticalsin/AskToto-Mantu/pull/69 | `cursor/brain-connectors-a8ba` | `cursor/overlay-chrome-island-f504` | `main` |

Their **heads still contain overlay 58 history**. Merging those heads into main would dump 58. Do **not** merge 68 or 69. Land the 68/69 *features* via #70, which does not contain 58 files.

```
command: git diff --name-only origin/main...cursor/land-upgrades-62-69-acda | rg overlay-chrome
exit_code: 1 (no matches)
```

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

Do not fake a DMG.

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

```
command: npx electron-builder --config electron-builder.win.yml --win --x64 --publish never
exit_code: 0
path: /opt/cursor/artifacts/electron-builder-win.log
```

afterPack: `[check:packaged-runtime] OK win (pre-sign)`.

`release/` is gitignored and each installer is **882 MB** (GitHub blob limit 100 MB). The binaries stay on this VM. sha256 is what is git-visible.

```
command: sha256sum release/Metis-Setup-1.6.6.exe release/Metis-Portable-1.6.6.exe release/win-unpacked/Metis.exe
exit_code: 0
path: /opt/cursor/artifacts/win-exe-hashes.txt
```

| path | size | sha256 |
| --- | --- | --- |
| `/workspace/release/Metis-Setup-1.6.6.exe` | 882M | `80a9f9cb2e1e89128f7a4016d1b1b66a189d1d13d2cb7db4c6178153db26fe1f` |
| `/workspace/release/Metis-Portable-1.6.6.exe` | 882M | `35fc57ce6ee89f89750bdfbfdefd532d45227473a29080b613484c4f19fa2178` |
| `/workspace/release/win-unpacked/Metis.exe` | 202M | `35235b2011ff87f1b10529f92ccc246ab952241b21aece596cd10b744787c6c0` |

`file`: Setup and Portable are PE32 Nullsoft installers. `win-unpacked/Metis.exe` is PE32+ x86-64.

Not launch-proved. Not ASR-proved. Not signed for customers.

## Upgrades commit

Branch `cursor/land-upgrades-62-69-acda`. Overlay 58 is not in this tree.
