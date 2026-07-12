import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FuseState, FuseV1Options, FuseVersion } from '@electron/fuses'
import { checkElectronFuses } from './check-electron-fuses.mjs'

describe('checkElectronFuses', () => {
  let root: string
  let app: string
  let executable: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'metis-fuses-'))
    app = join(root, 'Métis.app')
    const macos = join(app, 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    executable = join(macos, 'Métis')
    writeFileSync(executable, 'binary')
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads the executable inside the supplied app and requires RunAsNode enabled', async () => {
    const readFuses = vi.fn(async () => ({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: FuseState.ENABLE
    }))
    await expect(
      checkElectronFuses({ app, requireRunAsNode: true, readFuses })
    ).resolves.toMatchObject({ executable, runAsNode: 'enabled' })
    expect(readFuses).toHaveBeenCalledWith(executable)
  })

  it.each([FuseState.DISABLE, FuseState.REMOVED, FuseState.INHERIT])(
    'fails closed when RunAsNode is %s',
    async (state) => {
      await expect(
        checkElectronFuses({
          app,
          requireRunAsNode: true,
          readFuses: async () => ({ version: FuseVersion.V1, [FuseV1Options.RunAsNode]: state })
        })
      ).rejects.toThrow(/RunAsNode/i)
    }
  )

  it('rejects relative, missing, symlinked, or ambiguous app executables', async () => {
    await expect(checkElectronFuses({ app: 'Métis.app', readFuses: vi.fn() })).rejects.toThrow(/absolute/i)
    writeFileSync(join(app, 'Contents', 'MacOS', 'Other'), 'binary')
    await expect(checkElectronFuses({ app, readFuses: vi.fn() })).rejects.toThrow(/one executable/i)
  })
})
