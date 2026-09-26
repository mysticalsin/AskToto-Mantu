// W0-HERMETIC (M2-0190) — any harness that drives a REAL running app over CDP (e2e-workflows.mjs) must
// call assertSandboxedUserData() before it touches that app's settings/brain on disk.
//
// This is an allow-list, not a deny-list: ASKTOTO_USERDATA must resolve under the OS temp directory, or
// outside the user's home directory entirely. Nothing under the real home directory is trusted, because
// every real hazard — the real OneDrive/iCloud sync root, the real Métis userData profile, the real
// Keychain-backed settings store — lives somewhere under there, under names a fixed deny-list keeps
// missing: a business OneDrive root is `<home>/OneDrive - <Org>`, not `<home>/OneDrive`; the packaged
// and unpackaged Métis userData directories are `<home>/Library/Application Support/{Metis,asktoto-dev}`.
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * True when `child` resolves inside (or equal to) `parent`, compared as real path segments via
 * `path.relative` — a string-prefix compare would treat `<parent> - Other` as inside `<parent>`, and
 * needs a separate `sep`-aware case for every platform; `path.relative` handles both for free.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Throws unless `userDataDir` is set and resolves under `tmpDir`, or outside `homeDir` entirely.
 * `homeDir` and `tmpDir` are parameters (never read internally via `os.homedir()`/`os.tmpdir()`) so a
 * test can exercise every case without a real home or temp directory.
 *
 * @param {{ userDataDir: string | undefined, homeDir: string, tmpDir: string }} args
 * @returns {true}
 */
export function assertSandboxedUserData({ userDataDir, homeDir, tmpDir }) {
  if (!userDataDir) {
    throw new Error(
      'ASKTOTO_USERDATA is unset. This harness drives a REAL running app and mutates its settings/brain ' +
        'on disk — launch the app with ASKTOTO_USERDATA=<an isolated dir> set (see this file\'s own header), ' +
        'or it falls back to the real developer profile.'
    )
  }
  const resolvedUserData = resolve(userDataDir)
  if (isInside(tmpDir, resolvedUserData)) return true
  if (isInside(homeDir, resolvedUserData)) {
    throw new Error(
      `ASKTOTO_USERDATA (${userDataDir}) resolves inside the real home directory (${homeDir}) — the real ` +
        'synced meetings store, the real Métis userData profile and other real user state can all live ' +
        'there. Point it at a directory under the OS temp dir instead.'
    )
  }
  return true
}
