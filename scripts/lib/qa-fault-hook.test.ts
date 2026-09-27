import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import { installQaFaultHook } from '../../src/main/qa-identity'
import { assertQaFaultHookMatchesIdentity, QA_FAULT_MARKER, QA_IDENTITY_PACKAGE_NAME } from './qa-fault-hook.mjs'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Pack a temp directory holding a package.json { name } and an out/main/index.js that does or does not
 *  contain the QA fault marker — a stand-in for a real electron-builder app.asar. */
async function buildArchive(name: string, mainSource: string): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), 'asktoto-qa-fault-hook-'))
  dirs.push(src)
  await writeFile(join(src, 'package.json'), JSON.stringify({ name }))
  await mkdir(join(src, 'out', 'main'), { recursive: true })
  await writeFile(join(src, 'out', 'main', 'index.js'), mainSource)
  const dest = join(src, 'app.asar')
  await createPackage(src, dest)
  return dest
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
    const archive = await buildArchive(QA_IDENTITY_PACKAGE_NAME, `/* ${QA_FAULT_MARKER} */\n`)
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
})
