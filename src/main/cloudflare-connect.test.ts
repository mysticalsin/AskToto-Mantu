import { describe, expect, it } from 'vitest'
import { DEFAULT_OPERATOR_URL } from '@shared/operator'
import { cloudflareConnectTarget } from './cloudflare-connect'

describe('cloudflareConnectTarget', () => {
  it('defaults to the live Operator /cloudflare/connect', () => {
    expect(cloudflareConnectTarget({}, {})).toEqual({
      ok: true,
      href: `${DEFAULT_OPERATOR_URL}/cloudflare/connect`
    })
  })

  it('uses Settings operatorUrl when https', () => {
    expect(cloudflareConnectTarget({ operatorUrl: 'https://op.example.workers.dev/' }, {})).toEqual({
      ok: true,
      href: 'https://op.example.workers.dev/cloudflare/connect'
    })
  })

  it('refuses a non-https base', () => {
    expect(cloudflareConnectTarget({ operatorUrl: 'http://localhost:8787' }, {})).toEqual({
      ok: false,
      error: 'Operator URL must be https to open Cloudflare login.'
    })
  })
})
