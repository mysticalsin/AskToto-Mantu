import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const here = dirname(fileURLToPath(import.meta.url))

function cloudSttStartHandler(): string {
  const { text } = readModuleSource(here, '../index')
  const start = text.indexOf('ipcMain.handle(IPC.cloudSttStart,')
  const end = text.indexOf('ipcMain.handle(IPC.cloudSttStop,')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('legacy cloud STT start wiring', () => {
  it('derives the managed flag from the trusted enterprise profile, not from the renderer payload', () => {
    const handler = cloudSttStartHandler()
    expect(handler).toMatch(/managedProfile:\s*legacyDirectTokenGated\(\s*settings\s*\)/)
    expect(handler).not.toMatch(/managedProfile:\s*p\./)
  })

  it('reads the stored Cloudflare token only through the managed-profile gate', () => {
    const handler = cloudSttStartHandler()
    expect(handler).not.toMatch(/cloudflareToken:\s*getApiKey\(/)
    expect(handler).toMatch(
      /cloudflareToken:\s*readLegacyCloudflareToken\(\s*legacyDirectTokenGated\(\s*settings\s*\)\s*,/
    )
  })
})
