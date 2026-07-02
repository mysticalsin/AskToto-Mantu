// electron-builder afterPack hook (runs after packing, BEFORE signing).
//
// This repo lives inside OneDrive (CloudStorage), which stamps com.apple.FinderInfo / resource-fork
// extended attributes on files. Anything copied into the .app (extraResources: bundled ASR models,
// ort runtime; build icons) carries them along, and codesign then rejects the bundle with
// "resource fork, Finder information, or similar detritus not allowed". Strip all xattrs from the
// packed output before the signing step. No-op on Windows/Linux and harmless on clean checkouts (CI).
import { execFileSync } from 'node:child_process'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  console.log(`  • afterPack: stripping xattrs (OneDrive detritus) from ${context.appOutDir}`)
  execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'inherit' })
}
