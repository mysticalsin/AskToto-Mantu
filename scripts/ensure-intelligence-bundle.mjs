#!/usr/bin/env node
/**
 * One-shot Intelligence dashboard bundle for `npm run build` / `npm run dev`.
 * The dashboard is a separate Vite app. A forgotten `build:intelligence` left Tony
 * with the red "bundle not found" banner after a normal build.
 */
import { existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const INTELLIGENCE_BUNDLE_INDEX = join(ROOT, 'intelligence', 'dist', 'index.html')

export function intelligenceBundlePresent(path = INTELLIGENCE_BUNDLE_INDEX): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

const result = spawnSync('npm', ['run', 'build:intelligence'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (result.status !== 0) process.exit(result.status ?? 1)
if (!intelligenceBundlePresent()) {
  console.error('intelligence/dist/index.html missing after build:intelligence')
  process.exit(1)
}
