# Linux VM packaging evidence — 31 Aug 2026

Fail-closed. Every claim below is a command + exit_code + path.

Worker is **not** Totos-Mac. Combined local show tree `45a1139` is not in this clone. Electron was not opened there. No installer pack on Tony's Mac. Overlay **PR 58 stays frozen** (OPEN draft, tip `e6bc7bc`). This tree is **#70** (`cursor/land-upgrades-62-69-acda`) landing 62-69 only.

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

`after-pack.mjs` also calls `xattr` and `codesign` for mac targets. `scripts/build-mac-helper.mjs` needs `swiftc`. `electron-builder --mac` cannot emit a real DMG or a launchable LSUIElement `.app` here. Do not fake a DMG.

Three real paths if a Mac appears:

1. Tony Mac **Totos-Mac.local** — build `npm run dist` / `release:build:mac`, then `listwins` on the Hide park (that is PR 58 work, not this PR).
2. A **Mac cloud pool** once a team exists.
3. **Unsigned zip** as last: build on a Mac, then `listwins` on Totos-Mac.

## `npm run dist:win` — REFUSED (no override)

```
command: node scripts/check-build-host.mjs win
exit_code: 1
```

The guard refuses Windows packaging on `linux`. There is no override flag. The Windows chain is meant to launch `Metis.exe` and drive packaged ASR. This host cannot do that.

Tony bar asked this VM to invoke `electron-builder --win` **directly** after the upgrades commit. Packaged launch and packaged ASR gates are **not** run. An EXE from this host is cross-compiled, not launch-proved.

## Linux installer — BLOCKED by product policy

`scripts/after-pack.mjs` throws if `electronPlatformName` is not `darwin`/`mas*`/`win32`:

`Métis packaging supports macOS and Windows only`

No AppImage / deb from this product. Not attempted as a customer artifact.

## Windows EXE

In progress on this host. Hashes land in this file after `electron-builder --config electron-builder.win.yml --win --x64 --publish never`.

`release/` is gitignored (multi-GB). The EXE will not be committed if it exceeds GitHub's 100 MB blob limit. sha256 + absolute path stay git-visible here.

## Upgrades commit

Branch `cursor/land-upgrades-62-69-acda`. Overlay 58 is not in this tree.
