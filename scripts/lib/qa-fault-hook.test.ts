import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { createPackage, getRawHeader, uncache } from '@electron/asar'
import type { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { installQaFaultHook } from '../../src/main/qa-identity'
import { QA_CAPTURE_ENV } from '../../src/main/qa-capture-source'
import { assertQaFaultHookMatchesIdentity, QA_CAPTURE_MARKER, QA_FAULT_MARKER, QA_IDENTITY_PACKAGE_NAME } from './qa-fault-hook.mjs'

type AsarHeaderEntry = {
  files?: Record<string, AsarHeaderEntry>
  offset?: string
  size?: number
  unpacked?: boolean
}

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Pack a temp directory holding a package.json { name } and an out/main/index.js that does or does not
 *  contain the QA fault marker — a stand-in for a real electron-builder app.asar. */
async function buildArchive(name: string, mainSource: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asktoto-qa-fault-hook-'))
  dirs.push(root)
  const src = join(root, 'stage')
  const dest = join(root, 'app.asar')
  await writeStagedPackage(src, dest, name, mainSource)
  return dest
}

async function writeStagedPackage(src: string, dest: string, name: string, mainSource: string): Promise<void> {
  await mkdir(join(src, 'out', 'main'), { recursive: true })
  await writeFile(join(src, 'package.json'), JSON.stringify({ name }))
  await writeFile(join(src, 'out', 'main', 'index.js'), mainSource)
  // @electron/asar resolves with the writable stream returned by out.end(), before the stream
  // lifecycle has finished. Wait for the real writable completion before any synchronous asar read.
  const output = await createPackage(src, dest)
  await finished(output as unknown as Writable)
  await assertArchiveBytesComplete(dest)
}

async function assertArchiveBytesComplete(archive: string): Promise<void> {
  uncache(archive)
  try {
    const { header, headerSize } = getRawHeader(archive)
    const expectedSize = 8 + headerSize + packedPayloadSize(header)
    const actualSize = (await stat(archive)).size
    expect(actualSize).toBe(expectedSize)
  } finally {
    uncache(archive)
  }
}

function packedPayloadSize(entry: AsarHeaderEntry): number {
  if (entry.files) {
    return Math.max(0, ...Object.values(entry.files).map((child) => packedPayloadSize(child)))
  }
  if (entry.unpacked || entry.size === undefined || entry.offset === undefined) return 0
  return Number(entry.offset) + entry.size
}

describe('assertQaFaultHookMatchesIdentity', () => {
  it('Q1: a shipping package without the hook passes', async () => {
    const archive = await buildArchive('asktoto', 'console.log("shipping build")\n')
    expect(assertQaFaultHookMatchesIdentity(archive)).toEqual({ qaIdentity: false })
  })

  it('Q2: a shipping package whose main bundle carries the hook fails', async () => {
    const archive = await buildArchive('asktoto', `/* ${QA_FAULT_MARKER} */\n`)
    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/shipping package carries the QA fault hook/)
  })

  it('Q3: the QA-identity package with the hook passes', async () => {
    // M2-0494: a QA-identity main bundle carries both QA hooks, the fault hook and the capture source.
    const archive = await buildArchive(QA_IDENTITY_PACKAGE_NAME, `/* ${QA_FAULT_MARKER} ${QA_CAPTURE_MARKER} */\n`)
    expect(assertQaFaultHookMatchesIdentity(archive)).toEqual({ qaIdentity: true })
  })

  it('Q4: a QA-identity package without the hook fails', async () => {
    const archive = await buildArchive(QA_IDENTITY_PACKAGE_NAME, 'console.log("qa build")\n')
    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/QA-identity package lacks the QA fault hook/)
  })

  it('Q5: the hook the QA build compiles in raises the marker this gate looks for', () => {
    const before = process.listeners('SIGUSR2')
    installQaFaultHook()
    const added = process.listeners('SIGUSR2').find((listener) => !before.includes(listener))
    expect(added, 'installQaFaultHook did not add a SIGUSR2 listener').toBeDefined()
    try {
      expect(() => process.emit('SIGUSR2')).toThrow(QA_FAULT_MARKER)
    } finally {
      if (added) process.removeListener('SIGUSR2', added as unknown as (...args: any[]) => void)
    }
  })

  it('Q6: repeated shipping packages whose main bundle carries the hook fail deterministically', async () => {
    await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const archive = await buildArchive('asktoto', `/* ${QA_FAULT_MARKER} ${index} */\n`)
      expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/shipping package carries the QA fault hook/)
    }))
  })

  it('Q7: replacing an archive at the same path does not reuse a stale asar header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asktoto-qa-fault-hook-'))
    dirs.push(root)
    const src = join(root, 'stage')
    const archive = join(root, 'app.asar')
    await writeStagedPackage(src, archive, 'asktoto', 'console.log("shipping build")\n')
    expect(assertQaFaultHookMatchesIdentity(archive)).toEqual({ qaIdentity: false })

    await rm(src, { recursive: true, force: true })
    await writeStagedPackage(src, archive, QA_IDENTITY_PACKAGE_NAME, 'console.log("qa build")\n')
    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/QA-identity package lacks the QA fault hook/)
  })

  it('Q8: a readable ASAR header without flushed payload bytes fails before extracting package JSON', async () => {
    const archive = await buildArchive('asktoto', `/* ${QA_FAULT_MARKER} */\n`)
    const { headerSize } = getRawHeader(archive)
    await truncate(archive, 8 + headerSize)

    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/app\.asar is incomplete/)
  })

  it('Q9 (M2-0494): a shipping package whose main bundle carries the capture hook fails', async () => {
    const archive = await buildArchive('asktoto', `process.env.${QA_CAPTURE_MARKER}\n`)
    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/shipping package carries the QA capture hook/)
  })

  it('Q10 (M2-0494): a QA-identity package with the fault hook but without the capture hook fails', async () => {
    const archive = await buildArchive(QA_IDENTITY_PACKAGE_NAME, `/* ${QA_FAULT_MARKER} */\n`)
    expect(() => assertQaFaultHookMatchesIdentity(archive)).toThrow(/QA-identity package lacks the QA capture hook/)
  })

  it('Q11 (M2-0494): the gate looks for the env name the capture hook compiles in', () => {
    expect(QA_CAPTURE_MARKER).toBe(QA_CAPTURE_ENV)
  })
})
