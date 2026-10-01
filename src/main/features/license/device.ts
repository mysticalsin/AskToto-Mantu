/**
 * Local device identity for the Métis member pass.
 * Hardware serial when the OS can supply one; otherwise a stable install id.
 * Never invent a serial. Never send a raw serial off-device in this change.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { DEVICE_HASH_PREFIX, type SerialKind } from '@shared/license-types'
import { WINDOWS_POWERSHELL } from '../../win-security'

const PLACEHOLDER = new Set([
  '',
  'none',
  'null',
  'undefined',
  'to be filled by o.e.m.',
  'to be filled by oem',
  'default string',
  'system serial number',
  'not specified',
  'not available',
  'not applicable',
  'unknown',
  '0'
])

export interface DeviceIdentity {
  platform: NodeJS.Platform
  serialKind: SerialKind
  /** Raw hardware serial or, when unavailable, the install id. Local only. */
  stableId: string
  model: string
  deviceName: string
}

function clean(raw: string | undefined | null): string {
  return (raw ?? '').replace(/[\r\n\0]/g, '').trim()
}

export function isUsableSerial(raw: string | undefined | null): boolean {
  const s = clean(raw)
  if (!s) return false
  return !PLACEHOLDER.has(s.toLowerCase())
}

function readTextFile(path: string): string {
  try {
    if (!existsSync(path)) return ''
    return clean(readFileSync(path, 'utf8'))
  } catch {
    return ''
  }
}

function execText(cmd: string, args: string[], timeoutMs = 2000): string {
  try {
    return clean(execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return ''
  }
}

function macSerial(): string {
  const ioreg = execText('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
  const m = ioreg.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)
  return m?.[1] ? clean(m[1]) : ''
}

function macModel(): string {
  return execText('sysctl', ['-n', 'hw.model'])
}

/** Windows identity facts come from PowerShell, always the pinned System32 binary (see win-security.ts):
 *  Windows' CreateProcess search order includes the current working directory, so a bare 'powershell.exe'
 *  could execute an attacker-planted binary if Métis is ever launched from an attacker-writable cwd. */
function runPowerShell(command: string): string {
  return execText(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command])
}

function winSerial(): string {
  const bios = runPowerShell('(Get-CimInstance -ClassName Win32_BIOS).SerialNumber')
  if (isUsableSerial(bios)) return bios
  return runPowerShell('(Get-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid')
}

function winModel(): string {
  return runPowerShell('(Get-CimInstance -ClassName Win32_ComputerSystem).Model')
}

function linuxSerial(): string {
  const dmi = readTextFile('/sys/class/dmi/id/product_serial')
  if (isUsableSerial(dmi)) return dmi
  return ''
}

function linuxModel(): string {
  return readTextFile('/sys/class/dmi/id/product_name') || readTextFile('/sys/class/dmi/id/board_name')
}

export function readHardwareIdentity(platform: NodeJS.Platform = process.platform): {
  serial: string
  model: string
} {
  try {
    if (platform === 'darwin') return { serial: macSerial(), model: macModel() }
    if (platform === 'win32') return { serial: winSerial(), model: winModel() }
    return { serial: linuxSerial(), model: linuxModel() }
  } catch {
    return { serial: '', model: '' }
  }
}

export function defaultDeviceName(platform: NodeJS.Platform = process.platform): string {
  try {
    const host = clean(hostname())
    if (host) return host
  } catch {
    /* fall through */
  }
  if (platform === 'darwin') return 'This Mac'
  if (platform === 'win32') return 'This PC'
  return 'This device'
}

export function resolveDeviceIdentity(installId: string, platform: NodeJS.Platform = process.platform): DeviceIdentity {
  const hw = readHardwareIdentity(platform)
  const hardware = isUsableSerial(hw.serial)
  const host = defaultDeviceName(platform)
  return {
    platform,
    serialKind: hardware ? 'hardware' : 'install',
    stableId: hardware ? clean(hw.serial) : installId,
    model: hw.model,
    // Hostname first (what the person named the machine). Model is the subtitle path.
    deviceName: host
  }
}

/** SHA-256 hex. Stable for the same (id, platform). Never the raw serial. */
export function hashDeviceId(stableId: string, platform: NodeJS.Platform | string = process.platform): string {
  return createHash('sha256').update(`${DEVICE_HASH_PREFIX}\0${stableId}\0${platform}`, 'utf8').digest('hex')
}

export function formatSerialDisplay(raw: string, kind: SerialKind): string {
  const compact = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  if (!compact) return 'pending'
  // UUID-length or install-id fallback: last four only.
  if (kind === 'install' || compact.length >= 28) {
    return `···${compact.slice(-4)}`
  }
  const groups: string[] = []
  for (let i = 0; i < compact.length; i += 4) groups.push(compact.slice(i, i + 4))
  return groups.join(' · ')
}
