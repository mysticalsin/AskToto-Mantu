import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preloadSource = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
const sharedSource = readFileSync(join(__dirname, '../shared/import-jobs.ts'), 'utf8')
const packagedAsrSource = readFileSync(join(__dirname, '../../scripts/check-packaged-asr.mjs'), 'utf8')

function handlerBody(): string {
  const start = mainSource.indexOf('ipcMain.handle(IPC.importJobsList')
  const end = mainSource.indexOf('ipcMain.handle(IPC.importJobCancel', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return mainSource.slice(start, end)
}

describe('importJobsList cross-layer snapshot contract', () => {
  it('returns the full snapshot shape for signed-out callers', () => {
    const body = handlerBody()
    expect(body).toMatch(/if \(!requireAuth\(\)\) return \{[\s\S]*jobs: \[\][\s\S]*policyBlocked: false/)
    expect(body).toMatch(/heldJobIds: \[\]/)
    expect(body).toMatch(/policyHeldJobIds: \[\]/)
    expect(body).toMatch(/inventoryOverflow: false/)
    expect(body).toMatch(/policyHoldOverflow: false/)
  })

  it('uses the manager snapshot and maps only jobs to renderer-safe views', () => {
    const body = handlerBody()
    expect(body).toMatch(/await getImportJobs\(\)\.snapshot\(\)/)
    expect(body).toMatch(/jobs: snapshot\.jobs\.map\(importJobView\)/)
    expect(body).not.toMatch(/getImportJobs\(\)\.list\(\)/)
  })

  it('keeps preload, shared type, and packaged consumer on the same object contract', () => {
    expect(preloadSource).toMatch(/importJobsList: \(\): Promise<ImportJobsSnapshot>/)
    expect(sharedSource).toMatch(/interface ImportJobsSnapshot \{\s*jobs: ImportJobView\[\]/)
    expect(packagedAsrSource).toMatch(/importJobsList\(\)\)\.jobs\.find\(/)
  })
})
