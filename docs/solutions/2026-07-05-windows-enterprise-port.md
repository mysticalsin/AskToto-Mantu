# AskToto — Windows enterprise port (2026-07-05)

Porting a macOS-first Electron app (AskToto) to a fully-working, tested, signed, enterprise-ready
Windows build. Reusable findings.

## What broke on Windows and why

### 1. Test suite: POSIX assumptions in mac-only branches (7 failures)
`cli.test.ts`, `mcp/notebooklm.test.ts`, `recall.test.ts` mocked the macOS login-shell binary-resolution
path (`sh -lc 'command -v X'`) but never pinned `process.platform`. On a real win32 runner the code took
the `where`-based branch, the POSIX mocks missed, and every dependent assertion cascaded to `null`.
- **Fix:** pin `process.platform` to `'darwin'` for the suites that specifically exercise the login-shell
  branch, using the repo's existing `setPlatform` (`Object.defineProperty(process,'platform',…)` +
  `afterEach` restore) convention from `cli-win.test.ts`. The win32 branch stays covered by that file.
- `recall.test.ts` also used `file.split('/').pop()` to derive a basename — returns the whole path on
  win32. **Fix:** `path.basename` (handles `\` and `/`).
- **Lesson:** a green mac CI lane can hide platform-branch bugs that only fire on the *target* OS. When a
  test mocks an OS-specific syscall shape, pin the platform it is emulating.

### 2. Packaging: `tar xjf D:\...` parsed as a remote host
`fetch-models.mjs` extracted the Parakeet ASR archive with `tar xjf <absolute D:\ path>`. GNU tar reads
the drive-letter colon as a `host:path` rsh/rmt spec → `tar (child): Cannot connect to D: resolve failed`.
The weights never unpacked, so `dist:win` shipped without them.
- **Fix:** extract from `cwd=destDir` with a **relative** archive name (no colon). Works on both GNU tar
  (Git/MSYS) and the BSD tar in Windows System32.
- **Lesson:** never hand GNU tar an absolute Windows path; relative-name + cwd is the portable form.

### 3. Packaging: electron-builder winCodeSign extraction needs symlink privilege
`electron-builder --win` downloads `winCodeSign-2.6.0.7z` (for rcedit + signtool) on **every** build,
even unsigned. That archive contains macOS `.dylib` **symlinks**; 7-Zip fails to create them without
`SeCreateSymbolicLinkPrivilege` (non-admin + Developer Mode off) → the whole `--win` step aborts.
- **Root cause is an OS privilege, not app code.** Options: run the packaging step elevated; enable
  Windows Developer Mode (one-time, admin); build on CI `windows-latest` (elevated enough — the repo's
  `build.yml` already does); or pre-seed the stable `…/Cache/winCodeSign/winCodeSign-2.6.0/` dir with the
  Windows tools extracted (exclude `darwin/`) so app-builder skips the failing extraction.
- **Lesson:** this is the same class as the repo's documented "needs a Windows signing runner" blocker.

## Windows security hardening (found by the audit swarm, verified against live ACLs)

### CRITICAL — machine managed-config trust on Windows
`%ProgramData%\AskToto\managed-config.json` was trusted as authoritative IT policy (escrow pubkey,
tenant lock, provider allowlist, forced-auth). But `C:\ProgramData` grants `BUILTIN\Users:Write` by
default, so **any standard user (no elevation) can plant that file** and have it honored for every user —
e.g. `{"escrowPubKey": "<attacker key>"}` silently escrows every future transcript. macOS/Linux are safe
(root-owned dirs).
- **Fix:** new `src/main/win-security.ts` gates the machine policy behind a real ACL check
  (`trustedAdminManagedPath()`): honor it only if the file is owned by SYSTEM/Administrators/TrustedInstaller
  **and** no broad non-admin principal (Users, Authenticated Users, Everyone, Domain Users) holds a write
  ACE. `store.ts` / `auth.ts` / `transcripts.ts` now read the machine policy only through that gate (also
  de-duplicated 3 copies of the path). Covered by `win-security.test.ts`, including a **live ProgramData
  ACL proof** that the planted-forgery attack is rejected through the real PowerShell `Get-Acl` reader.
- **Lesson:** a config-file "admin-only" trust assumption that holds on POSIX (root-owned dir) does NOT
  hold on Windows without an explicit owner/ACL check.

### MAJOR — `writeFileSync(..., { mode: 0o600 })` is a no-op on Windows
Node ignores POSIX mode bits on win32; files inherit the parent ACL. The cleartext transcript that
`decryptToTemp` drops in `%TEMP%` claimed "owner-only (0o600)" but got no owner-only DACL.
- **Fix:** `lockPathToCurrentUserWin32()` applies an explicit owner-only DACL via `icacls` after write;
  corrected the misleading comment.

### MINOR — MSAL loopback advertised `localhost`, bound `127.0.0.1`
On Windows `localhost` resolves to `::1` first; the browser's OAuth callback could stall/drop.
- **Fix:** advertise `http://127.0.0.1:${port}` to match the bind (Entra loopback accepts it).

## UX (Windows)
- Onboarding copy hardcoded "on your Mac" — shown to Windows users. Fixed via the existing `keys.ts`
  `isWindows` signal → "your computer" on win32. Settings Dust-CLI hint "macOS may ask…" → "Your OS".
- Hotkeys already used `CommandOrControl` (→ Ctrl) and the tray/keys.ts already translated glyphs, so no
  `⌘` leaks to Windows users. platform-perms.ts already had a correct win32 branch.

## Signing
- `scripts/sign-win.mjs`: reproducible Authenticode signer — finds `signtool.exe` (Windows SDK or the
  electron-builder winCodeSign cache), signs installers with an RFC3161 timestamp, and positively verifies
  with `Get-AuthenticodeSignature`. This is the non-admin/local path; CI with a real cert uses
  electron-builder's native signing. `verifyUpdateCodeSignature: true` requires `win.publisherName` to
  equal the signing cert's subject CN exactly (bare `Mantu` matches a `CN=Mantu` cert).

## Evidence
- `npm ci` / `typecheck` exit 0; **vitest 534 passed / 4 skipped / 0 failed on Windows** (+9 new
  win-security tests). Boot + UX Playwright launch: overlay renders, **0 console/page errors**. Secret
  scan clean, `npm audit` 0 critical (highs are build-time devDeps / unreachable express-under-dust),
  SBOM 766 components.
