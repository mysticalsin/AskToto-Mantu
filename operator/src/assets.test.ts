import { describe, expect, it } from 'vitest'
import { OPERATOR_CLIENT_JS, isPublicAssetPath, publicAssetResponse } from './assets'

describe('Operator /assets/* — public JS, never Access HTML', () => {
  it('treats /assets/* as a public path', () => {
    expect(isPublicAssetPath('/assets/client.js')).toBe(true)
    expect(isPublicAssetPath('/assets/missing.js')).toBe(true)
    expect(isPublicAssetPath('/')).toBe(false)
    expect(isPublicAssetPath('/v1/admin/summary')).toBe(false)
    expect(isPublicAssetPath('/v1/heartbeat')).toBe(false)
  })

  it('serves the client JS bundle as JavaScript, not HTML', async () => {
    const res = publicAssetResponse('/assets/client.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('content-type')).not.toMatch(/html/)
    const body = await res.text()
    expect(body).toBe(OPERATOR_CLIENT_JS)
    expect(body).not.toMatch(/<!doctype html|<html|cloudflareaccess/i)
    expect(body).toMatch(/metisOperatorClient/)
  })

  it('missing assets are JSON 404, never a login page', async () => {
    const res = publicAssetResponse('/assets/index-missing.js')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(res.headers.get('content-type')).not.toMatch(/html/)
    const body = await res.text()
    expect(body).not.toMatch(/<!doctype html|<html|cloudflareaccess/i)
  })
})
