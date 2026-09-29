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

export const RV_SCENARIOS = Object.freeze([
  { id: 'RV-1-macos-open-activate', platform: 'darwin', reason: 'activate', automation: 'open-app-path' },
  { id: 'RV-2-macos-open-new-instance', platform: 'darwin', reason: 'second-instance', automation: 'open-new-instance' },
  { id: 'RV-3-windows-exe-relaunch', platform: 'win32', reason: 'second-instance', automation: 'exe-relaunch' },
  { id: 'RV-4-tray-show', platform: 'all', reason: 'tray', automation: 'tray-menu' },
  { id: 'RV-4-global-hotkey', platform: 'all', reason: 'hotkey', automation: 'global-hotkey' },
  { id: 'RV-1-macos-finder-spotlight-launchpad', platform: 'darwin', reason: 'activate', automation: 'finder-open-app-file' },
  { id: 'RV-3-windows-shortcut-relaunch', platform: 'win32', reason: 'second-instance', automation: 'windows-shortcut' }
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

async function waitForReveal(auditLogPath, reason, seenCount) {
  const deadline = Date.now() + RV_TIMEOUT_MS
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

export function isPassingRevealEvidence(reveal) {
  return reveal !== null && reveal.parked === true && (reveal.outcome === 'created' || reveal.outcome === 'shown')
}

export async function runRevealRow({
  auditLogPath,
  rows,
  id,
  reason,
  prepare,
  run,
  failure,
  countReveals = revealCount,
  waitForRevealRecord = waitForReveal
}) {
  const prepared = prepare ? await prepare() : { error: false }
  const seen = countReveals(auditLogPath, reason)
  const launched = prepared.error ? prepared : await run()
  const reveal = launched.error ? null : await waitForRevealRecord(auditLogPath, reason, seen)
  const pass = isPassingRevealEvidence(reveal)
  completeRvRow(rows, id, {
    status: pass ? 'PASS' : 'FAIL',
    evidence: reveal ? {
      event: 'reveal',
      reason,
      outcome: reveal.outcome ?? null,
      parked: reveal.parked === true,
      layout: typeof reveal.layout === 'string' ? reveal.layout : null
    } : null,
    unblock: pass ? null : failure
  })
}

/**
 * A .lnk shortcut cannot carry process environment variables, so Windows-shortcut reopen targets a tiny
 * generated .cmd that sets ASKTOTO_USERDATA (and the smoke reopen probe) before starting Metis.exe.
 * Without that indirection, the shortcut launches the executable directly with none of this run's
 * isolated env, so the relaunch resolves the real default profile instead of colliding with this run's
 * single-instance lock: it never reveals the window under test, and it is never quit, leaving an
 * unmanaged orphan under the install root after quit.
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
    '$shortcut.Save()',
    `Start-Process -FilePath ${JSON.stringify(shortcutPath)}`
  ].join('; ')
  return { shortcutPath, launcherPath, launcherBody, shortcutScript }
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
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-exe-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runProcess(executable, [], 10_000, { env }),
      failure: 'Inspect the packaged-smoke artifact and the app audit log for the missing second-instance reveal event.'
    })

    const { launcherPath, launcherBody, shortcutScript } = buildWindowsShortcutLauncher({
      auditLogDir: dirname(auditLogPath),
      executable,
      userData: env.ASKTOTO_USERDATA,
      reopenProbe: env.ASKTOTO_SMOKE_REOPEN_PROBE
    })
    writeFileSync(launcherPath, launcherBody, 'utf8')
    await runRevealRow({
      auditLogPath,
      rows,
      id: 'RV-3-windows-shortcut-relaunch',
      reason: 'second-instance',
      prepare: hideBeforeReveal,
      run: () => runPowerShell(shortcutScript, 10_000),
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
