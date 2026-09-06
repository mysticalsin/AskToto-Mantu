import { describe, expect, it } from 'vitest'
import {
  BUNDLE_DISK,
  BUNDLE_GOT_LOGIN_HTML,
  BUNDLE_NETWORK,
  BUNDLE_NOT_JS,
  bundleFailureUserMessage,
  bundleKindForUrl,
  inspectBundleResponse,
  isHtmlContentType,
  isRetryableBundleMessage,
  looksLikeAccessLoginHtml,
  looksLikeAccessRedirect,
  looksLikeHtml,
  looksLikeHtmlBytes
} from './bundle-response'

const ACCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Sign in · Cloudflare Access</title></html>
<body>
  <form action="https://team.cloudflareaccess.com/cdn-cgi/access/login">
    <input name="1d_token" />
  </form>
</body>
</html>`

const REAL_JS = `'use strict';\nexport const metisOperatorClient = true;\n`

describe('bundle-response — Access HTML is never a successful bundle', () => {
  it('detects Cloudflare Access login HTML', () => {
    expect(looksLikeAccessLoginHtml(ACCESS_HTML)).toBe(true)
    expect(looksLikeHtml(ACCESS_HTML)).toBe(true)
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true)
    expect(looksLikeHtmlBytes(new TextEncoder().encode(ACCESS_HTML))).toBe(true)
  })

  it('rejects Access 302 / followed 200 HTML for every bundle kind', () => {
    for (const expected of ['js', 'wasm', 'onnx', 'archive', 'json', 'binary'] as const) {
      expect(
        inspectBundleResponse({
          status: 302,
          location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login',
          expected
        })
      ).toEqual({ ok: false, message: BUNDLE_GOT_LOGIN_HTML })
      expect(
        inspectBundleResponse({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          bodyPrefix: ACCESS_HTML,
          expected
        })
      ).toEqual({ ok: false, message: BUNDLE_GOT_LOGIN_HTML })
    }
  })

  it('rejects HTTP-not-JS when a script was required', () => {
    expect(
      inspectBundleResponse({
        status: 200,
        contentType: 'application/json',
        bodyPrefix: '{"ok":false,"error":"not found"}',
        expected: 'js'
      })
    ).toEqual({ ok: false, message: BUNDLE_NOT_JS })
  })

  it('accepts a real JS client bundle and a binary ONNX prefix', () => {
    expect(
      inspectBundleResponse({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        bodyPrefix: REAL_JS,
        expected: 'js'
      }).ok
    ).toBe(true)
    const onnx = new Uint8Array([0x08, 0x01, 0x12, 0x04, 0x00, 0x00])
    expect(looksLikeHtmlBytes(onnx)).toBe(false)
    expect(
      inspectBundleResponse({
        status: 200,
        contentType: 'application/octet-stream',
        bodyPrefix: String.fromCharCode(...onnx),
        expected: 'onnx'
      }).ok
    ).toBe(true)
  })

  it('maps network, disk, and Access failures to Retry copy', () => {
    expect(bundleFailureUserMessage(new Error('fetch failed'))).toBe(BUNDLE_NETWORK)
    expect(bundleFailureUserMessage(new Error('ENOSPC: no space left on device'))).toBe(BUNDLE_DISK)
    expect(bundleFailureUserMessage(new Error(ACCESS_HTML))).toBe(BUNDLE_GOT_LOGIN_HTML)
    expect(bundleFailureUserMessage(new Error('HTTP 302 for https://operator.test/assets/client.js'))).toBe(
      BUNDLE_NETWORK
    )
    expect(isRetryableBundleMessage(BUNDLE_GOT_LOGIN_HTML)).toBe(true)
    expect(isRetryableBundleMessage(BUNDLE_NOT_JS)).toBe(true)
    expect(isRetryableBundleMessage(BUNDLE_DISK)).toBe(true)
    expect(isRetryableBundleMessage('Getting transcription files…')).toBe(false)
    expect(bundleFailureUserMessage(new Error('incomplete download: got 12 of 40 bytes'))).toBe(
      BUNDLE_NETWORK
    )
    expect(isRetryableBundleMessage('incomplete download')).toBe(true)
  })

  it('only treats Cloudflare Access locations as login redirects', () => {
    expect(looksLikeAccessRedirect('https://team.cloudflareaccess.com/cdn-cgi/access/login')).toBe(true)
    expect(looksLikeAccessRedirect('https://cdn.hf.co/x/encoder.int8.onnx')).toBe(false)
  })

  it('classifies Operator /assets/*.js as a JS bundle', () => {
    expect(bundleKindForUrl('https://operator.test/assets/client.js')).toBe('js')
    expect(bundleKindForUrl('https://huggingface.co/x/resolve/main/encoder.int8.onnx')).toBe('onnx')
    expect(bundleKindForUrl('https://github.com/x/y.tar.bz2')).toBe('archive')
  })
})
