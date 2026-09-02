import { describe, expect, it } from 'vitest'
import { classifyOperatorReply, looksLikeHtml, operatorReplyProblem } from './operator-response'

const ACCESS_LOGIN = 'https://tony-walteur.cloudflareaccess.com/cdn-cgi/access/login/metis-operator.tony-walteur.workers.dev?kid=abc'

const ACCESS_HTML = `<!DOCTYPE html>
<html><head><title>Sign in · Cloudflare Access</title></head>
<body><form action="https://tony-walteur.cloudflareaccess.com/cdn-cgi/access/login"></form></body></html>`

describe('classifyOperatorReply', () => {
  it('names an Access 302 for what it is and never treats it as ok', () => {
    const reply = classifyOperatorReply({ status: 302, location: ACCESS_LOGIN, text: '' })
    expect(reply).toEqual({ ok: false, reason: 'access', status: 302, json: null })
    expect(operatorReplyProblem('/v1/heartbeat', reply as Exclude<typeof reply, { ok: true }>)).toMatch(
      /behind Cloudflare Access.*bypass Access.*operator\/README\.md/
    )
  })

  it('refuses a followed Access login page (200 text/html)', () => {
    const reply = classifyOperatorReply({ status: 200, contentType: 'text/html; charset=utf-8', text: ACCESS_HTML })
    expect(reply).toEqual({ ok: false, reason: 'access', status: 200, json: null })
  })

  it('refuses any HTML or non-JSON body even with a JSON content-type claim', () => {
    expect(classifyOperatorReply({ status: 200, contentType: 'application/json', text: '<html><body>x</body></html>' })).toEqual({
      ok: false,
      reason: 'html',
      status: 200,
      json: null
    })
    expect(classifyOperatorReply({ status: 200, contentType: 'application/json', text: 'not json' })).toEqual({
      ok: false,
      reason: 'not-json',
      status: 200,
      json: null
    })
  })

  it('keeps a JSON error body on an HTTP failure and passes a JSON 2xx through', () => {
    expect(classifyOperatorReply({ status: 401, contentType: 'application/json', text: '{"ok":false,"error":"bad signature"}' })).toEqual({
      ok: false,
      reason: 'http',
      status: 401,
      json: { ok: false, error: 'bad signature' }
    })
    expect(classifyOperatorReply({ status: 200, contentType: 'application/json; charset=utf-8', text: '{"ok":true,"retry":["a"]}' })).toEqual({
      ok: true,
      json: { ok: true, retry: ['a'] }
    })
  })

  it('a non-Access redirect is still a failure, just not blamed on Access', () => {
    const reply = classifyOperatorReply({ status: 301, location: 'https://example.com/moved', text: '' })
    expect(reply).toMatchObject({ ok: false, reason: 'redirect', status: 301 })
  })

  it('looksLikeHtml only fires on an HTML prefix', () => {
    expect(looksLikeHtml('\uFEFF  <!doctype html><html>')).toBe(true)
    expect(looksLikeHtml('{"ok":true}')).toBe(false)
    expect(looksLikeHtml('')).toBe(false)
  })
})
