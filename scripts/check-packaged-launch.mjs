#!/usr/bin/env node
/**
 * Launch the packaged app and prove it actually starts. The last gate before a release ships.
 *
 * Every other release gate inspects files: the sidecars are present, the architecture is right, the
 * update manifest hashes match, the binary is signed. None of them start the app, so a build whose
 * main process dies on the first require() passes all of them. That is exactly how 1.5.3 shipped to
 * Windows dead with `cachedDataRejected` — the same V8 bytecode/Electron mismatch that shipped in
 * 1.2.0 — and how 1.2.0 shipped before it.
 *
 * Reading stdout is not enough to catch it. A packaged Electron app is built as a Windows GUI
 * binary (subsystem:windows) with no console attached, and the failure surfaces through
 * dialog.showErrorBox, so the message exists ONLY as a native dialog. This gate therefore asserts on
 * the real top-level window: a healthy launch shows a window titled after the product, and a dead
 * one shows a dialog titled "Error". When it finds that dialog it reads the text out of it via UI
 * Automation, so CI shows the actual stack instead of "no window appeared".
 *
 * Usage: node scripts/check-packaged-launch.mjs <path-to-exe-or-app> [--timeout-seconds 120]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
const timeoutIndex = process.argv.indexOf('--timeout-seconds')
const timeoutSeconds = timeoutIndex === -1 ? 150 : Number(process.argv[timeoutIndex + 1])

if (!target) {
  console.error('usage: node scripts/check-packaged-launch.mjs <path-to-packaged-executable>')
  process.exit(2)
}
if (!existsSync(target)) {
  console.error(`[check:launch] FAIL — no such executable: ${target}`)
  process.exit(1)
}
// Windows-only by construction: the window/dialog inspection below is Win32. Refuse loudly rather
// than exiting 0 elsewhere — a gate that silently passes is worse than no gate. macOS needs its own
// equivalent before the mac release path can claim this coverage.
if (process.platform !== 'win32') {
  console.error(`[check:launch] FAIL — this gate only runs on Windows (host is ${process.platform}).`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isWindows = process.platform === 'win32'
// Resolve powershell by absolute path: Node's spawn searches PATH only, with no System32 fallback.
const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

function ps(command) {
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 60000,
    }).trim()
  } catch (error) {
    return `PS_ERROR: ${String(error?.message || error).slice(0, 300)}`
  }
}

/** Every visible top-level window title belonging to a process named like the app. */
function windowTitles() {
  if (!isWindows) return []
  const out = ps(
    "Get-Process -Name 'Metis*' -ErrorAction SilentlyContinue | " +
      "Where-Object {$_.MainWindowTitle -ne ''} | ForEach-Object { $_.MainWindowTitle }"
  )
  if (!out || out.startsWith('PS_ERROR')) return []
  return [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
}

/**
 * Read the text of the error dialog. showErrorBox content never reaches stdout on a GUI-subsystem
 * binary, so without this the CI log would report a missing window and none of the reason.
 */
function readErrorDialog() {
  if (!isWindows) return ''
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procs = Get-Process -Name 'Metis*' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($proc in $procs) {
  $el = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if ($null -eq $el) { continue }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
  foreach ($c in $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    if ($c.Current.Name -and $c.Current.Name.Trim() -ne '') { Write-Output $c.Current.Name }
  }
}`
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'metis-launch-ua-')), 'read-dialog.ps1')
  // PS 5.1 reads a BOM-less file as ANSI; keep the file ASCII and write it plainly.
  writeFileSync(scriptPath, script, 'ascii')
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 60000,
    }).trim()
  } catch {
    return ''
  } finally {
    try { rmSync(scriptPath, { force: true }) } catch {}
  }
}

function killApp() {
  if (isWindows) ps("Get-Process -Name 'Metis*' -ErrorAction SilentlyContinue | Stop-Process -Force")
}

// A clean profile on purpose: a leftover profile can hide a first-run crash.
const userData = mkdtempSync(join(tmpdir(), 'metis-launch-'))
const env = { ...process.env, ASKTOTO_USERDATA: userData, ELECTRON_ENABLE_LOGGING: '1' }
// A real provider key changes startup routing; the gate must measure the shipped default path.
for (const key of Object.keys(env)) if (/_API_KEY$/i.test(key)) delete env[key]

console.log(`[check:launch] launching ${target}`)
console.log(`[check:launch]   clean profile: ${userData}`)

let stdio = ''
const child = spawn(target, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', (d) => (stdio += d))
child.stderr.on('data', (d) => (stdio += d))
let exited = null
child.on('exit', (code, signal) => (exited = { code, signal }))

let titles = []
const deadline = Date.now() + timeoutSeconds * 1000
// A portable build unpacks well over a gigabyte before the first paint, so poll rather than
// assuming a fixed warm-up.
while (Date.now() < deadline) {
  await sleep(5000)
  titles = windowTitles()
  if (titles.length) break
  if (exited) break
}

let appLog = ''
const logDir = join(userData, 'logs')
if (existsSync(logDir)) {
  for (const file of readdirSync(logDir)) {
    try { appLog += readFileSync(join(logDir, file), 'utf8') } catch {}
  }
}

const haystack = `${stdio}\n${appLog}`
const healthy = titles.some((t) => /M.tis/i.test(t))
const errorDialog = titles.some((t) => /^Error$/i.test(t))
let dialogText = ''
if (errorDialog || !healthy) dialogText = readErrorDialog()

const combined = `${haystack}\n${dialogText}`
const bytecodeDoa = /cachedDataRejected|Invalid or incompatible cached data/i.test(combined)
const mainProcessError = /A JavaScript error occurred in the main process/i.test(combined)

console.log(`[check:launch] window titles : ${JSON.stringify(titles)}`)
if (exited) console.log(`[check:launch] exited early  : ${JSON.stringify(exited)}`)

killApp()

if (healthy && !bytecodeDoa && !mainProcessError) {
  console.log(`[check:launch] OK — the packaged app started and showed its window`)
  process.exit(0)
}

console.error('[check:launch] FAIL — the packaged app did not start cleanly.')
if (bytecodeDoa) {
  console.error(
    '[check:launch] cachedDataRejected: the V8 bytecode in out/main is not loadable by the packaged\n' +
      '[check:launch]   Electron. Bytecode is tied to the exact V8 build, platform AND architecture that\n' +
      '[check:launch]   produced it (electron.vite.config.ts sets bytecode: true), so a Windows package\n' +
      '[check:launch]   must be built ON Windows with the same Electron. Rebuild from a clean out/.'
  )
} else if (mainProcessError) {
  console.error('[check:launch] the main process threw before the first window.')
} else if (!titles.length) {
  console.error('[check:launch] no window ever appeared within the timeout.')
}
if (dialogText) console.error(`[check:launch] --- error dialog ---\n${dialogText}`)
if (appLog) console.error(`[check:launch] --- app log tail ---\n${appLog.split('\n').slice(-25).join('\n')}`)
if (stdio.trim()) console.error(`[check:launch] --- stdio tail ---\n${stdio.split('\n').slice(-25).join('\n')}`)
process.exit(1)
