import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNetworkLicenseClient } from './client'

// MQA-333: licence identifiers must use protected transport and never follow redirects.

afterEach(() => vi.unstubAllGlobals())

describe('network member-licence transport', () => {
  const activation = {
    licenseKey: 'TEST-KEY',
    deviceIdHash: 'a'.repeat(64),
    appVersion: '1.9.6',
    os: 'darwin'
  }
  const install = { installId: '00000000-0000-4000-8000-000000000000', appVersion: '1.9.6', os: 'darwin' }

  it('never sends activation or install identifiers to explicit remote HTTP', async () => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    const client = createNetworkLicenseClient('http://licenses.example.test')

    expect(await client.activate(activation)).toEqual({ ok: false, error: 'network' })
    expect(await client.registerInstall(install)).toEqual({ ok: false, error: 'network' })
    expect(network).not.toHaveBeenCalled()
  })

  it('uses HTTPS for a bare remote host', async () => {
    const network = vi.fn(async () => new Response('{"ok":false,"error":"network"}', {
      headers: { 'content-type': 'application/json' }
    }))
    vi.stubGlobal('fetch', network)

    const client = createNetworkLicenseClient('licenses.example.test')
    await client.activate(activation)
    await client.registerInstall(install)

    expect(network).toHaveBeenCalledWith('https://licenses.example.test/v1/licenses/activate', expect.objectContaining({ redirect: 'error' }))
    expect(network).toHaveBeenCalledWith('https://licenses.example.test/v1/installs/register', expect.objectContaining({ redirect: 'error' }))
  })
})
