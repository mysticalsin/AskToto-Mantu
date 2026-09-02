import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSrc = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')

// The live recap cannot fire until listen.stop()'s drain settles (up to 6 s on Parakeet/Apple). When the
// on-device model will write the notes, that window used to precede a cold model load instead of hiding it.
describe('Stop warms the on-device summarizer during the drain', () => {
  it('endReview asks main to prewarm with the summary intent before listen.stop()', () => {
    const end = appSrc.indexOf('const endReview = useCallback(() => {')
    expect(end).toBeGreaterThan(-1)
    const body = appSrc.slice(end, appSrc.indexOf('const toggleListen = useCallback', end))
    const prewarm = body.indexOf("window.toto.localPrewarm(tail, 'summary')")
    const stop = body.indexOf('listen.stop()')
    expect(prewarm).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(prewarm)
    // Same readiness rule maybeFireRecap uses to pick mode:'summary' — never a warm for a cloud recap.
    expect(body).toMatch(/!!settings\?\.localSummaryReady \|\| \(!settings\?\.providerReady && !!settings\?\.localFallbackReady\)/)
  })
})
