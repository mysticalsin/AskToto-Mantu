import { describe, expect, it } from 'vitest'
import { policyDigest, readCustomMcpPolicy } from './policy'

const admin = (block: unknown): string => JSON.stringify({ customMcp: block })

describe('custom MCP policy', () => {
  it('defaults deny stdio and private network', () => {
    const p = readCustomMcpPolicy(null, null)
    expect(p).toMatchObject({
      allow: true,
      allowStdio: false,
      allowPrivateNetwork: false,
      allowedHosts: null,
      maxTools: 64
    })
    expect(readCustomMcpPolicy('{}', '{}').allowStdio).toBe(false)
  })

  it('malformed customMcp block fails closed naming customMcp.invalid', () => {
    expect(readCustomMcpPolicy(admin('yes'), null)).toMatchObject({ allow: false, deniedRule: 'customMcp.invalid' })
    expect(readCustomMcpPolicy(admin({ allowStdio: 'true' }), null)).toMatchObject({ deniedRule: 'customMcp.invalid' })
    expect(readCustomMcpPolicy('{not json', null)).toMatchObject({ allow: false, deniedRule: 'customMcp.invalid' })
    expect(readCustomMcpPolicy(admin({ stdioExecutables: [{ path: '/x', sha256: 'zz' }] }), null).allow).toBe(false)
    expect(readCustomMcpPolicy(null, admin(7)).allow).toBe(false)
  })

  it('admin policy can grant stdio with a pinned executable', () => {
    const sha = 'a'.repeat(64)
    const p = readCustomMcpPolicy(
      admin({ allowStdio: true, stdioExecutables: [{ path: '/opt/x', sha256: sha }] }),
      null
    )
    expect(p.allowStdio).toBe(true)
    expect(p.stdioExecutables).toEqual([{ path: '/opt/x', sha256: sha }])
  })

  it('user managed file cannot grant allowStdio or private networks', () => {
    const p = readCustomMcpPolicy(null, admin({ allowStdio: true, allowPrivateNetwork: true, allowedHosts: null }))
    expect(p.allowStdio).toBe(false)
    expect(p.allowPrivateNetwork).toBe(false)
  })

  it('user file can restrict allow:false and narrow hosts', () => {
    expect(readCustomMcpPolicy(null, admin({ allow: false }))).toMatchObject({
      allow: false,
      deniedRule: 'customMcp.allow'
    })
    const p = readCustomMcpPolicy(
      admin({ allowedHosts: ['a.example', 'b.example'] }),
      admin({ allowedHosts: ['b.example', 'c.example'] })
    )
    expect(p.allowedHosts).toEqual(['b.example'])
  })

  it('maxTools clamps to 64', () => {
    expect(readCustomMcpPolicy(admin({ maxTools: 500 }), null).maxTools).toBe(64)
    expect(readCustomMcpPolicy(admin({ maxTools: 10 }), admin({ maxTools: 3 })).maxTools).toBe(3)
  })

  it('digest changes when a grant changes', () => {
    const a = policyDigest(readCustomMcpPolicy(null, null))
    const b = policyDigest(readCustomMcpPolicy(admin({ allowPrivateNetwork: true }), null))
    expect(a).not.toBe(b)
    expect(a).toBe(policyDigest(readCustomMcpPolicy(null, null)))
  })
})
