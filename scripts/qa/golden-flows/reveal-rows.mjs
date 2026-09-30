/**
 * The packaged reveal (RV-*) rows of the packaged smoke (M2-0007, split out by M2-0410): each row parks the
 * overlay, triggers one reopen path (activate, second instance, tray, global hotkey) and passes only on the
 * matching `reveal` audit record with `parked === true`.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcess, sleep } from '../lib/app-driver.mjs'
import { AUDIT_POLL_MS, parkAndProve, parseAuditLog, readAuditLog } from './smoke-support.mjs'

const RV_TIMEOUT_MS = 15_000
export const RV_BOOT_ROW_ID = 'RV-boot-launch-activate-stays-parked'
// The budget a direct relaunch's run() gives the relaunched instance to boot, hand off to the running app
// and exit. A detached relaunch (the Windows shortcut's `start`) resolves run() before that boot, so its
// reveal window adds this budget on top of RV_TIMEOUT_MS instead of spending the boot inside it.
const RELAUNCH_BOOT_MS = 10_000
// Content-free audit context a failing RV row carries: this many records before the relaunch baseline,
// and at most RV_AUDIT_AFTER after it.
const RV_AUDIT_BEFORE = 3
const RV_AUDIT_AFTER = 40

export const RV_SCENARIOS = Object.freeze([
  { id: 'RV-1-macos-open-activate', platform: 'darwin', reason: 'activate', automation: 'open-app-path' },
  { id: 'RV-2-macos-open-new-instance', platform: 'darwin', reason: 'second-instance', automation: 'open-new-instance' },
  { id: 'RV-3-windows-exe-relaunch', platform: 'win32', reason: 'second-instance', automation: 'exe-relaunch' },
  { id: 'RV-4-tray-show', platform: 'all', reason: 'tray', automation: 'tray-menu' },
  { id: 'RV-4-global-hotkey', platform: 'all', reason: 'hotkey', automation: 'global-hotkey' },
  { id: 'RV-1-macos-finder-spotlight-launchpad', platform: 'darwin', reason: 'activate', automation: 'finder-open-app-file' },
  { id: 'RV-3-windows-shortcut-relaunch', platform: 'win32', reason: 'second-instance', automation: 'windows-shortcut' },
  { id: RV_BOOT_ROW_ID, platform: 'darwin', reason: 'activate', automation: 'launchservices-cold-launch' }
])

export function initialRvRows(platform) {
  return RV_SCENARIOS
    .filter((scenario) => scenario.platform === 'all' || scenario.platform === platform)
    .map((scenario) => ({
      id: scenario.id,
      reason: scenario.reason,
      automation: scenario.automation,
      status: 'PENDING',
      evidence: null,
      unblock: null
    }))
}

function completeRvRow(rows, id, patch) {
  const row = rows.find((entry) => entry.id === id)
  if (row) Object.assign(row, patch)
}

async function runAppleScript(script, timeoutMs) {
  return runProcess('osascript', ['-e', script], timeoutMs)
}

async function runPowerShell(script, timeoutMs) {
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs)
}

async function waitForReveal(auditLogPath, reason, seenCount, timeoutMs = RV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = parseAuditLog(readAuditLog(auditLogPath))
    const matches = records.filter((record) => record.event === 'reveal' && record.reason === reason)
    if (matches.length > seenCount) return matches[matches.length - 1]
    await sleep(AUDIT_POLL_MS)
  }
  return null
}

function revealCount(auditLogPath, reason) {
  return parseAuditLog(readAuditLog(auditLogPath)).filter((r) => r.event === 'reveal' && r.reason === reason).length
}

function auditRecords(auditLogPath) {
  return parseAuditLog(readAuditLog(auditLogPath))
}

export function isPassingRevealEvidence(reveal) {
  return reveal !== null && reveal.parked === true && (reveal.outcome === 'created' || reveal.outcome === 'shown')
}

const REVEAL_DIAGNOSTIC_FIELDS = ['reason', 'outcome', 'isVisible', 'parked', 'layout', 'ms']

/** An audit record reduced to its event name; a `reveal` keeps only its enum/boolean/number projection fields. */
export function auditDiagnostic(record) {
  const out = { event: typeof record?.event === 'string' ? record.event : null }
  if (out.event !== 'reveal') return out
  for (const field of REVEAL_DIAGNOSTIC_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') out[field] = value
  }
  return out
}

function processOutcome(result) {
  return { code: result?.code ?? null, signal: result?.signal ?? null, error: result?.error === true }
}

export async function runRevealRow({
  auditLogPath,
  rows,
  id,
  reason,
  prepare,
  run,
  failure,
  revealTimeoutMs = RV_TIMEOUT_MS,
  countReveals = revealCount,
  waitForRevealRecord = waitForReveal
}) {
  const prepared = prepare ? await prepare() : { error: false }
  const baseline = auditRecords(auditLogPath).length
  const seen = countReveals(auditLogPath, reason)
  const launchedAt = Date.now()
  const launched = prepared.error ? prepared : await run()
  const reveal = launched.error ? null : await waitForRevealRecord(auditLogPath, reason, seen, revealTimeoutMs)
  const pass = isPassingRevealEvidence(reveal)
  let diagnostics = null
  if (!pass) {
    // A rotated log restarts shorter than the baseline; every record in it is then after the relaunch.
    const records = auditRecords(auditLogPath)
    const split = records.length >= baseline ? baseline : 0
    diagnostics = {
      stage: prepared.error ? 'prepare' : launched.error ? 'launch' : reveal === null ? 'no-reveal' : 'reveal-not-passing',
      prepare: processOutcome(prepared),
      launch: prepared.error ? null : processOutcome(launched),
      waitedMs: Date.now() - launchedAt,
      auditBefore: records.slice(Math.max(0, split - RV_AUDIT_BEFORE), split).map(auditDiagnostic),
      auditAfter: records.slice(split, split + RV_AUDIT_AFTER).map(auditDiagnostic)
    }
    console.error(`[packaged-smoke] ${id} FAIL ${JSON.stringify(diagnostics)}`)
  }
  completeRvRow(rows, id, {
    status: pass ? 'PASS' : 'FAIL',
    evidence: reveal ? {
      event: 'reveal',
      reason,
      outcome: reveal.outcome ?? null,
      parked: reveal.parked === true,
      layout: typeof reveal.layout === 'string' ? reveal.layout : null
    } : null,
    unblock: pass ? null : failure,
    ...(diagnostics ? { diagnostics } : {})
  })
}

/**
 * A .lnk shortcut cannot carry process environment variables, so Windows-shortcut reopen targets a tiny
 * generated .cmd that sets ASKTOTO_USERDATA (and the smoke reopen probe) before starting Metis.exe.
 * Without that indirection, the shortcut launches the executable directly with none of this run's
 * isolated env, so the relaunch resolves the real default profile instead of colliding with this run's
 * single-instance lock: it never reveals the window under test, and it is never quit, leaving an
 * unmanaged orphan under the install root after quit.
 *
 * `shortcutScript` only creates the .lnk (a WScript.Shell COM activation, seconds on a cold hosted runner);
 * `launchScript` only opens it, the way a user's double-click does. They run as separate steps so the COM
 * activation never spends the relaunch's own budget.
 */
export function buildWindowsShortcutLauncher({ auditLogDir, executable, userData, reopenProbe = '' }) {
  if (typeof userData !== 'string' || userData.length === 0) {
    throw new Error('windows shortcut smoke requires ASKTOTO_USERDATA in the reopen env')
  }
  const shortcutPath = join(auditLogDir, 'Metis-smoke.lnk')
  const launcherPath = join(auditLogDir, 'Metis-smoke-launch.cmd')
  const launcherBody = [
    '@echo off',
    `set "ASKTOTO_USERDATA=${userData}"`,
    `set "ASKTOTO_SMOKE_REOPEN_PROBE=${reopenProbe}"`,
    `start "" ${JSON.stringify(executable)}`
  ].join('\r\n')
  const shortcutScript = [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut(${JSON.stringify(shortcutPath)})`,
    `$shortcut.TargetPath = ${JSON.stringify(launcherPath)}`,
    `$shortcut.WorkingDirectory = ${JSON.stringify(dirname(executable))}`,
    '$shortcut.Save()'
  ].join('; ')
  const launchScript = `Start-Process -FilePath ${JSON.stringify(shortcutPath)}`
  return { shortcutPath, launcherPath, launcherBody, shortcutScript, launchScript }
}

export async function runPackagedRvRows({ platform, target, executable, auditLogPath, rows, env }) {
  const userData = env.ASKTOTO_USERDATA
  const hideBeforeReveal = async () => parkAndProve({ executable, env, userData })
  if (platform === 'darwin') {
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-1-macos-open-activate',
      reason: 'activate',
      prepare: hideBeforeReveal,
      run: () => runProcess('open', [target], 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing activate reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-2-macos-open-new-instance',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      // `open -n` launches through LaunchServices, which does not forward the calling process's
      // environment to the app it starts — ASKTOTO_USERDATA would never reach it, so the relaunch would
      // boot against the real default profile instead of colliding with this run's isolated lock and
      // would leave an unmanaged, unquit orphan behind. A direct relaunch of the installed executable (the
      // same single-instance-lock code path `open -n` would hit) reliably carries the isolated env, exactly
      // like the RV-3 Windows exe relaunch below.
      run: () => runProcess(executable, [], 10_000, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-1-macos-finder-spotlight-launchpad',
      reason: 'activate',
      prepare: hideBeforeReveal,
      run: () => runAppleScript(`tell application "Finder" to open POSIX file ${JSON.stringify(target)}`, 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing Finder activate reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-4-global-hotkey',
      reason: 'hotkey',
      prepare: hideBeforeReveal,
      run: () => runAppleScript('tell application "System Events" to keystroke return using {command down, shift down}', 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing global-hotkey reveal event.'
    })
  }

  if (platform === 'win32') {
    // A cold hosted runner can spend more than the 10 s row budget just starting PowerShell, which kills
    // the shortcut script before it launches anything. Warm it once, outside every row's budget.
    await runPowerShell('exit 0', 120_000)
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-exe-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess(executable, [], RELAUNCH_BOOT_MS, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    const { launcherPath, launcherBody, shortcutScript, launchScript } = buildWindowsShortcutLauncher({
      auditLogDir: dirname(auditLogPath),
      executable,
      userData: env.ASKTOTO_USERDATA,
      reopenProbe: env.ASKTOTO_SMOKE_REOPEN_PROBE
    })
    writeFileSync(launcherPath, launcherBody, 'utf8')
    // Created once, outside the row's launch budget, like the PowerShell warm-up above.
    const shortcutCreated = await runPowerShell(shortcutScript, 120_000)
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-shortcut-relaunch',
      reason: 'second-instance',
      prepare: async () => (shortcutCreated.code === 0 ? hideBeforeReveal() : { ...shortcutCreated, error: true }),
      // Start-Process returns once ShellExecute has started the .cmd, whose `start` detaches Metis.exe, so
      // the relaunched instance boots after run() resolves: its boot budget is part of the reveal window.
      run: () => runPowerShell(launchScript, 30_000),
      revealTimeoutMs: RELAUNCH_BOOT_MS + RV_TIMEOUT_MS,
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing Windows shortcut reveal event.'
    })

    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-4-global-hotkey',
      reason: 'hotkey',
      prepare: hideBeforeReveal,
      run: () => runPowerShell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^+{ENTER}')", 10_000),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing global-hotkey reveal event.'
    })
  }

  await runRevealRow({
    auditLogPath,
    rows,
    id: 'RV-4-tray-show',
    reason: 'tray',
    run: () => runProcess(executable, ['--metis-smoke-reopen=tray-show'], 10_000, { env }),
    failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing tray reveal event.'
  })
}
