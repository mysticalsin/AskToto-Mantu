import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanLocalAiWorker } from './clean-local-ai-worker.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metis-worker-clean-'))
  temporaryRoots.push(root)
  return root
}

describe('cleanLocalAiWorker', () => {
  it('removes only the previous local worker output tree', async () => {
    const root = await temporaryRepo()
    const worker = join(root, 'out', 'local-ai-worker')
    const main = join(root, 'out', 'main')
    await mkdir(join(worker, 'nested'), { recursive: true })
    await mkdir(main, { recursive: true })
    await writeFile(join(worker, 'nested', 'stale.mjs'), 'stale')
    await writeFile(join(main, 'index.js'), 'keep')

    await cleanLocalAiWorker(root)

    expect(existsSync(worker)).toBe(false)
    await expect(readFile(join(main, 'index.js'), 'utf8')).resolves.toBe('keep')
  })

  it('is idempotent when the worker output does not exist', async () => {
    const root = await temporaryRepo()

    await expect(cleanLocalAiWorker(root)).resolves.toBeUndefined()
    expect(existsSync(join(root, 'out', 'local-ai-worker'))).toBe(false)
  })

  it('is invoked before TypeScript by the worker build script', async () => {
    const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

    expect(pkg.scripts['build:local-ai-worker']).toBe(
      'node scripts/clean-local-ai-worker.mjs && tsc -p tsconfig.local-ai-worker.json'
    )
  })
})
