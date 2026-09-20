import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(SCRIPTS_DIR, '..')
let runtimeAssetsChecked = false

/** Reject an incomplete offline payload before electron-builder creates a misleading app directory. */
export default async function beforePack() {
  if (runtimeAssetsChecked) return
  execFileSync(process.execPath, [join(SCRIPTS_DIR, 'check-runtime-assets.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })
  runtimeAssetsChecked = true
}
