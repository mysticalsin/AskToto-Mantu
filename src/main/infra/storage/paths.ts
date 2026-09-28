/**
 * Where the meetings root is: the folder set in Settings, else `<OneDrive>/Métis Meetings`, else
 * `<Documents>/Métis Meetings` (inside ASKTOTO_USERDATA for physical QA). Only this module decides it.
 * The storage gateway receives the root injected (gateway.ts), so gateway code and its tests never
 * resolve a real OneDrive folder themselves.
 */
import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Settings } from '@shared/ipc'

// detectOneDrive() does a handful of sync fs calls (existsSync/readdirSync) and its answer can't change
// mid-process (the OneDrive sync root doesn't move while Métis is running) — resolveMeetingsFolder
// calls it on every settings read, so memoize once per process rather than re-stating the same paths
// every time.
let _oneDriveCache: string | undefined

/** Find the user's OneDrive root. Cross-platform (macOS / Windows / Linux). */
export function detectOneDrive(): string {
  if (_oneDriveCache !== undefined) return _oneDriveCache
  return (_oneDriveCache = detectOneDriveUncached())
}

function detectOneDriveUncached(): string {
  // Windows: OneDrive sets env vars to its sync roots.
  if (process.platform === 'win32') {
    for (const e of [process.env.OneDriveCommercial, process.env.OneDrive, process.env.OneDriveConsumer]) {
      if (e && existsSync(e)) return e
    }
    const winAlt = join(homedir(), 'OneDrive')
    return existsSync(winAlt) ? winAlt : ''
  }
  // macOS: ~/Library/CloudStorage/OneDrive-*
  try {
    const base = join(homedir(), 'Library', 'CloudStorage')
    if (existsSync(base)) {
      const dirs = readdirSync(base)
      const personal = dirs.find((d) => /^OneDrive-(?!SharedLibraries)/i.test(d))
      const any = dirs.find((d) => /^OneDrive/i.test(d))
      if (personal) return join(base, personal)
      if (any) return join(base, any)
    }
  } catch {
    /* ignore */
  }
  // Linux / fallback
  const alt = join(homedir(), 'OneDrive')
  return existsSync(alt) ? alt : ''
}

// Pre-rebrand sibling folder: before "AskToto" became "Métis" the app wrote transcripts to a folder
// literally named "AskToto Meetings" next to wherever this file resolves today — the userData
// profile-dir migration (index.ts, on the app-name rename) moved settings.json/secret-key.bin, but
// never this folder, so those meetings simply stopped showing up in Recall even though they're still
// sitting on disk. This copy is ONE-TIME and PURELY ADDITIVE: only files absent at the destination are
// copied in, and the source folder is never written to or deleted — a failed/partial run always leaves
// the original fully recoverable. Copied 'S:'-wrapped meetings converge to this device's file-backend
// key the first time they're opened (see decryptEnvelopeV2's self-healing rewrap).
const COPY_FORWARD_MARKER = '.copied-legacy-asktoto-meetings'

function copyForwardLegacyMeetingsOnce(folder: string): void {
  try {
    const userDataDir = app.getPath('userData')
    if (!userDataDir) return // app not ready (test environment) — never block a read on this
    const marker = join(userDataDir, COPY_FORWARD_MARKER)
    if (existsSync(marker)) return // already ran (this launch or a previous one) — marker is the single source of truth
    // Sibling of the RESOLVED folder (not a fixed path): the legacy folder sat next to whichever
    // location — OneDrive root, Documents, or an explicit user folder — was in force at the time.
    const legacy = join(dirname(folder), 'AskToto Meetings')
    if (existsSync(legacy)) {
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
      for (const dirent of readdirSync(legacy, { withFileTypes: true })) {
        // README.md/index.md are bookkeeping this folder regenerates itself (ensureMeetingsFolder) —
        // only real meeting/note files need copying forward. Never follow a symlink planted with a
        // meeting-shaped name (mirrors recoverOrphanDrafts' same guard).
        if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue
        if (dirent.name === 'README.md' || dirent.name === 'index.md') continue
        const dest = join(folder, dirent.name)
        if (!existsSync(dest)) copyFileSync(join(legacy, dirent.name), dest) // additive only — never overwrite
      }
    }
    // Written whether or not a legacy folder was found, so a device that never had one doesn't pay
    // this existsSync/readdirSync cost again on every future launch either.
    writeFileSync(marker, new Date().toISOString(), 'utf8')
  } catch {
    // Non-fatal, mirrors index.ts's profile-dir migration idiom: worst case the copy-forward retries
    // next launch (the marker write below was never reached) — never block a read on it.
  }
}

/** The folder transcripts are written to (explicit setting, else OneDrive, else Documents). */
export function resolveMeetingsFolder(settings: Settings): string {
  if (settings.meetingsFolder) {
    copyForwardLegacyMeetingsOnce(settings.meetingsFolder)
    return settings.meetingsFolder
  }
  // `ASKTOTO_USERDATA` is the packaged-app physical-QA hook. Keep its implicit meeting store under
  // that temporary profile too: otherwise the normal OneDrive fallback would make an apparently
  // isolated test read and write the operator's real meeting data. No copy-forward here either — an
  // isolated QA profile must never pull in the operator's real legacy meetings.
  const qaUserData = process.env.ASKTOTO_USERDATA?.trim()
  if (qaUserData) return join(qaUserData, 'Métis Meetings')
  const base = detectOneDrive() || app.getPath('documents')
  const folder = join(base, 'Métis Meetings')
  copyForwardLegacyMeetingsOnce(folder)
  return folder
}
