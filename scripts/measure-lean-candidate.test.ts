import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const sourceScript = fileURLToPath(new URL('./measure-lean-candidate.mjs', import.meta.url))
let fixtureRoot: string

function zeroBytesSha256(byteCount: number): string {
  const hash = createHash('sha256')
  const zeros = Buffer.alloc(1024 * 1024)
  for (let remaining = byteCount; remaining > 0; ) {
    const chunkBytes = Math.min(remaining, zeros.byteLength)
    hash.update(zeros.subarray(0, chunkBytes))
    remaining -= chunkBytes
  }
  return hash.digest('hex')
}

describe('measure-lean-candidate strict installer-size verdict', () => {
  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'metis-lean-size-measurement-'))
    const scriptDirectory = join(fixtureRoot, 'scripts')
    const appResources = join(fixtureRoot, 'release', 'lean-win-x64', 'win-unpacked', 'resources')
    mkdirSync(scriptDirectory, { recursive: true })
    mkdirSync(appResources, { recursive: true })
    copyFileSync(sourceScript, join(scriptDirectory, 'measure-lean-candidate.mjs'))
    writeFileSync(
      join(appResources, 'package-inventory.json'),
      JSON.stringify({ profile: 'lean', arch: 'x64', platform: 'win32' })
    )
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  it.each([
    { bytes: 149_999_999, status: 0, underLimit: true },
    { bytes: 150_000_000, status: 1, underLimit: false },
    { bytes: 150_000_001, status: 1, underLimit: false }
  ])('measures $bytes exact installer bytes and persists evidence before its verdict', ({
    bytes,
    status,
    underLimit
  }) => {
    const outputDirectory = join(fixtureRoot, 'release', 'lean-win-x64')
    const installerPath = join(outputDirectory, 'Metis-Setup.exe')
    const installerFd = openSync(installerPath, 'w')
    try {
      ftruncateSync(installerFd, bytes)
    } finally {
      closeSync(installerFd)
    }

    const result = spawnSync(
      process.execPath,
      [join(fixtureRoot, 'scripts', 'measure-lean-candidate.mjs'), 'win', 'x64', 'release/lean-win-x64'],
      { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(status)

    const evidencePath = join(fixtureRoot, 'build', 'lean-measurements', 'win-x64.json')
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    expect(evidence.installer.name).toBe('Metis-Setup.exe')
    expect(evidence.installer.bytes).toBe(bytes)
    expect(evidence.installer.sha256).toBe(zeroBytesSha256(bytes))
    expect(evidence.installer.under150MB).toBe(underLimit)
  })
})
