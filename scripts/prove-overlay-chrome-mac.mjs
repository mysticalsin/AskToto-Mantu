#!/usr/bin/env node
/**
 * Fail-closed Mac proof for overlay PR 58 (Hide 8×2 after display move, Island hover).
 * Linux is the wrong worker for notch / exclusive fullscreen / hide-until-hover.
 * Exit 0 only on darwin after listwins reports Hide W=8 H<=8.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { hostname, platform } from 'node:os'

const PATHS = [
  'Tony Mac Totos-Mac.local (run this script there after launching Métis from cursor/overlay-chrome-island-f504)',
  'A Mac cloud pool once a team exists (Darwin worker with a notch display and display-move)',
  'Unsigned zip as last (build on a Mac, copy Metis.app, then listwins on Totos-Mac.local)'
]

const out = process.env.ASKTOTO_PROOF_OUT || ''

function record(payload, code) {
  const text = JSON.stringify(payload, null, 2) + '\n'
  if (out) {
    try {
      writeFileSync(out, text)
    } catch {
      /* ignore */
    }
  }
  process.stdout.write(text)
  process.exit(code)
}

if (platform() !== 'darwin') {
  record(
    {
      verdict: 'BLOCKED',
      reason: 'This worker is not Darwin. Linux cannot prove notch / exclusive fullscreen / hide-until-hover.',
      platform: platform(),
      hostname: hostname(),
      command: 'node scripts/prove-overlay-chrome-mac.mjs',
      exit_code: 1,
      path: new URL(import.meta.url).pathname,
      mac_paths: PATHS
    },
    1
  )
}

let listwins = ''
try {
  listwins = execFileSync(
    'osascript',
    [
      '-e',
      'tell application "System Events" to get {name, position, size} of every window of (every process whose name contains "Métis" or name contains "Metis" or name contains "Electron")'
    ],
    { encoding: 'utf8', timeout: 8000 }
  ).trim()
} catch (err) {
  record(
    {
      verdict: 'BLOCKED',
      reason: 'darwin but listwins failed (app not running, or no Automation grant).',
      platform: platform(),
      hostname: hostname(),
      command: 'osascript listwins',
      exit_code: 1,
      path: new URL(import.meta.url).pathname,
      error: String(err && err.message ? err.message : err),
      mac_paths: PATHS
    },
    1
  )
}

const nums = listwins.match(/-?\d+/g)?.map(Number) ?? []
const sizes = []
for (let i = 0; i + 1 < nums.length; i += 2) {
  if (nums[i] > 0 && nums[i] < 4000 && nums[i + 1] > 0 && nums[i + 1] < 4000) {
    sizes.push({ width: nums[i], height: nums[i + 1] })
  }
}

const hidePark = sizes.some((s) => s.width === 8 && s.height <= 8)
if (!hidePark) {
  record(
    {
      verdict: 'BLOCKED',
      reason: 'No window with width 8 and height <= 8. Hide idle is not parked, or BAR_MIN_HEIGHT 44 leaked.',
      platform: platform(),
      hostname: hostname(),
      command: 'osascript listwins',
      exit_code: 1,
      path: new URL(import.meta.url).pathname,
      listwins,
      sizes,
      mac_paths: PATHS
    },
    1
  )
}

record(
  {
    verdict: 'PASS',
    reason: 'Hide park width 8 height <= 8 on darwin.',
    platform: platform(),
    hostname: hostname(),
    command: 'node scripts/prove-overlay-chrome-mac.mjs',
    exit_code: 0,
    path: new URL(import.meta.url).pathname,
    listwins,
    sizes
  },
  0
)
