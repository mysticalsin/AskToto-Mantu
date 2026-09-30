/**
 * Moves the real OS pointer for packaged-app QA (ADR-018, M2-0039) and proves it moved. A move is a straight
 * rightward path at a fixed speed (or a jump when the speed is 0); the driver reads the pointer back at the
 * end, so a runner session that silently ignores the warp is reported as a failure, never as a measurement.
 * Coordinates are screen points: macOS global display points, Windows pixels at the runner's 100 % scaling.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { win32PowerShell } from './lib.mjs'

/** A read-back further than this from the requested end point means the warp did not take. */
export const POINTER_READBACK_TOLERANCE_PX = 2

/** JXA: argv is fromX toX y speedPxPerMs entryX; prints { entryAt, endAt, readBack }. */
export const DARWIN_POINTER_DRIVER = `ObjC.import('CoreGraphics')
ObjC.import('AppKit')
function run(argv) {
  const [fromX, toX, y, speed, entryX] = argv.map(Number)
  const start = Date.now()
  let entryAt = null
  for (;;) {
    const x = Math.round(speed > 0 ? Math.min(toX, fromX + (Date.now() - start) * speed) : toX)
    $.CGWarpMouseCursorPosition({ x: x, y: y })
    if (entryAt === null && x >= entryX) entryAt = Date.now()
    if (x >= toX) break
    delay(0.004)
  }
  const endAt = Date.now()
  delay(0.05)
  const at = $.NSEvent.mouseLocation
  const primaryHeight = $.NSScreen.screens.objectAtIndex(0).frame.size.height
  return JSON.stringify({ entryAt: entryAt, endAt: endAt, readBack: { x: Math.round(at.x), y: Math.round(primaryHeight - at.y) } })
}
`

/** Windows PowerShell: same arguments and output as the macOS driver. */
export const WIN32_POINTER_DRIVER = `param([double]$FromX, [double]$ToX, [double]$Y, [double]$Speed, [double]$EntryX)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$entryAt = $null
while ($true) {
  if ($Speed -gt 0) { $x = [Math]::Min($ToX, $FromX + $clock.ElapsedMilliseconds * $Speed) } else { $x = $ToX }
  $xi = [int][Math]::Round($x)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($xi, [int][Math]::Round($Y))
  if ($null -eq $entryAt -and $xi -ge $EntryX) { $entryAt = Now }
  if ($xi -ge $ToX) { break }
  Start-Sleep -Milliseconds 4
}
$endAt = Now
Start-Sleep -Milliseconds 50
$at = [System.Windows.Forms.Cursor]::Position
[ordered]@{ entryAt = $entryAt; endAt = $endAt; readBack = [ordered]@{ x = $at.X; y = $at.Y } } | ConvertTo-Json -Compress
`

/** A jump to one point: no path, and the entry is the jump itself. */
export function stationaryMove(point) {
  return { fromX: point.x, toX: point.x, y: point.y, speedPxPerMs: 0, entryX: point.x }
}

/** Positional driver arguments; integral, non-negative and rightward only, so no argument can parse as a flag. */
export function pointerDriverArgs(move) {
  const values = [move.fromX, move.toX, move.y, move.speedPxPerMs, move.entryX]
  if (!values.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('pointer moves need finite, non-negative screen coordinates and speed')
  }
  if (move.toX < move.fromX) throw new Error('pointer moves run rightward: toX must be >= fromX')
  if (![move.fromX, move.toX, move.y, move.entryX].every(Number.isInteger)) {
    throw new Error('pointer move coordinates must be whole screen points')
  }
  return values.map(String)
}

/** The command that runs the platform driver at `scriptPath`; null where no driver exists. */
export function pointerDriverCommand(platform, scriptPath, move) {
  const args = pointerDriverArgs(move)
  if (platform === 'darwin') return { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', scriptPath, ...args] }
  if (platform === 'win32') {
    return { command: win32PowerShell(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args] }
  }
  return null
}

/** Parses the driver's JSON line and refuses a move whose read-back is not where it was sent. */
export function parsePointerDriverOutput(stdout, move) {
  const line = String(stdout).trim().split(/\r?\n/).at(-1) ?? ''
  let result
  try {
    result = JSON.parse(line)
  } catch {
    throw new Error(`pointer driver printed no result: ${line.slice(0, 120)}`)
  }
  const { entryAt, endAt, readBack } = result ?? {}
  if (!Number.isFinite(endAt) || !Number.isFinite(readBack?.x) || !Number.isFinite(readBack?.y)) {
    throw new Error('pointer driver result is missing endAt or readBack')
  }
  if (
    Math.abs(readBack.x - move.toX) > POINTER_READBACK_TOLERANCE_PX ||
    Math.abs(readBack.y - move.y) > POINTER_READBACK_TOLERANCE_PX
  ) {
    throw new Error(`pointer did not move: asked for (${move.toX},${move.y}), read back (${readBack.x},${readBack.y})`)
  }
  if (!Number.isFinite(entryAt)) throw new Error('pointer driver never reached entryX')
  return { entryAt, endAt, readBack }
}

let driverDir = null

/** Runs one move on this machine and resolves with { entryAt, endAt, readBack }; rejects when the pointer did not move. */
export async function movePointer(move, { platform = process.platform, timeoutMs = 30_000 } = {}) {
  if (!pointerDriverCommand(platform, 'probe', move)) throw new Error(`no pointer driver for ${platform}`)
  driverDir ??= mkdtempSync(join(tmpdir(), 'metis-pointer-'))
  const scriptPath = join(driverDir, `pointer-driver.${platform === 'win32' ? 'ps1' : 'js'}`)
  const invocation = pointerDriverCommand(platform, scriptPath, move)
  writeFileSync(scriptPath, platform === 'win32' ? WIN32_POINTER_DRIVER : DARWIN_POINTER_DRIVER, 'utf8')
  const stdout = await new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, { encoding: 'utf8', timeout: timeoutMs }, (error, out, err) => {
      if (error) reject(new Error(`pointer driver failed: ${String(err || error.message).trim().slice(0, 200)}`))
      else resolve(out)
    })
  })
  return parsePointerDriverOutput(stdout, move)
}

/** "x,y" → { x, y } with whole non-negative screen points. */
export function parsePoint(text) {
  const match = /^(\d+),(\d+)$/.exec(String(text ?? '').trim())
  if (!match) throw new Error(`expected a screen point as x,y (whole non-negative numbers), got: ${text}`)
  return { x: Number(match[1]), y: Number(match[2]) }
}
