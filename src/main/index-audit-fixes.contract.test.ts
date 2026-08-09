import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Regression locks for the index.ts findings of the 2026-08 Windows audit (MQA-037, 038, 051, 054, 056,
// 062, 064, 070, 075, 081, 090). src/main/index.ts boots Electron at import time and every one of these
// seams is a closure inside an ipcMain handler or a window-event callback, so there is no index.test.ts
// anywhere in this repo — the established pattern (pinned-agent-boundary.contract.test.ts,
// ask-freshness.contract.test.ts, c-main-fixes.contract.test.ts) pins the invariant against the actual
// source. Where a fix IS a self-contained expression, the expression itself is lifted out of the source
// and executed below, so those assertions test the shipped logic rather than its shape.
//
// NOT COVERED HERE — MQA-059 (a revoked key silently absorbed by cross-provider failover). Main already
// computes and ships the honest signal (`unhealthyProviders` on the settings snapshot, index.ts), but no
// renderer component consumes it, and every remedy the ledger accepts lands in files this change does not
// own (src/renderer/src/App.tsx to render the banner, src/shared/ipc.ts for a distinct key-failed field).
// The one index.ts-local option — folding provider health into `providerReady` — is the change the
// verifier explicitly flagged as riskier, because ~10 renderer gates currently succeed via failover.
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Slice the source from `from` up to (excluding) the next occurrence of `to`. Sliced inside each test so
 *  one drifted marker reports as its own failure instead of aborting collection for the whole file. */
function sliceBetween(from: string, to: string): string {
  const start = indexSrc.indexOf(from)
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1)
  const end = indexSrc.indexOf(to, start)
  expect(end, `end marker not found after ${from}: ${to}`).toBeGreaterThan(-1)
  return indexSrc.slice(start, end)
}

describe('MQA-037 — the retry idle cap is a network diagnostic and must not shrink a local attempt', () => {
  // Lift the real idleMs expression out of index.ts and run it: the defect was a wrong VALUE (20s of
  // time-to-first-token for an on-device prefill budgeted at 120s), not a wrong-looking line.
  type IdleBudget = (
    localColdStart: boolean,
    attempted: string[],
    provider: string,
    baseIdleMs: number,
    coldMs: number,
    capMs: number
  ) => number
  const idleBudget = (): IdleBudget => {
    const expr = sliceBetween('const idleMs = localColdStart', 'const startedAt = Date.now()')
      .replace(/^const idleMs =/, '')
      .trim()
    return new Function(
      'localColdStart',
      'attempted',
      'provider',
      'baseIdleMs',
      'LOCAL_COLD_START_IDLE_MS',
      'RETRY_IDLE_CAP_MS',
      `return (${expr})`
    ) as IdleBudget
  }

  it('gives a WARM local fallback summary its full mode budget, not the 20s retry cap', () => {
    // The zero-config safety net dispatches attempt('local', attempted.concat(provider)), so a local
    // attempt ALWAYS arrives with attempted.length >= 1 even though the preceding step was a pure
    // in-memory config check that never opened a socket.
    expect(idleBudget()(false, ['anthropic'], 'local', 120_000, 90_000, 20_000)).toBe(120_000)
  })

  it('gives a WARM local fallback vision ask its full mode budget too', () => {
    expect(idleBudget()(false, ['dust'], 'local', 60_000, 90_000, 20_000)).toBe(60_000)
  })

  it('still caps a genuine cross-provider network retry (the case the cap exists for)', () => {
    expect(idleBudget()(false, ['anthropic'], 'openai', 120_000, 90_000, 20_000)).toBe(20_000)
  })

  it('leaves the first attempt and the cold-start floor untouched', () => {
    expect(idleBudget()(false, [], 'anthropic', 45_000, 90_000, 20_000)).toBe(45_000)
    expect(idleBudget()(true, ['anthropic'], 'local', 15_000, 90_000, 20_000)).toBe(90_000)
  })
})

describe('MQA-038 — a renderer crash re-syncs the renderer-owned meeting state', () => {
  const handler = (): string =>
    sliceBetween("win.webContents.on('render-process-gone', (_e, details) => {", '// Dev-only: screenshot ONLY this window')

  it('resets the fresh-question boundary so a later plain ask cannot inherit the dead meeting', () => {
    const body = handler()
    expect(body).toMatch(/listeningActive = false/)
    expect(body).toMatch(/lastPlainAskAt = 0/)
    expect(body).toMatch(/resetDustConversation\(\)/)
  })

  it('clears the meeting-in-progress side effects the dead renderer can no longer turn off', () => {
    const body = handler()
    expect(body).toMatch(/audioArmed = false/)
    expect(body).toMatch(/setTrayRecording\(false\)/)
    expect(body).toMatch(/setRecordingPowerSaveBlock\(false\)/)
  })

  it('keeps that state at module scope so the crash handler can actually reach it', () => {
    // Recovery reloads the SAME window (pinned by c-main-fixes.contract.test.ts), so createWindow() never
    // re-runs — the state has to outlive the IPC-registration closure it used to be declared in.
    expect(indexSrc).toMatch(/^let listeningActive = false$/m)
    expect(indexSrc).toMatch(/^let lastPlainAskAt = 0/m)
  })
})

describe('MQA-051 / MQA-054 — the Dust keep-warm runs on every platform', () => {
  const keepWarm = (): string => sliceBetween('const refreshAndPersistDust = (at: string): void => {', 'auditLog(')

  it('is gated on a connected Dust account only — never on darwin', () => {
    const body = keepWarm()
    expect(body).toMatch(/if \(!hasApiKey\('dust'\)\) return/)
    expect(body).not.toMatch(/process\.platform/)
  })

  it('still skips the re-mint while the token is inside its freshness window', () => {
    expect(keepWarm()).toMatch(/DUST_TOKEN_FRESH_MS\) return/)
  })
})

describe('MQA-056 — imported-recap falls back to the on-device model as a last resort', () => {
  const recap = (): string =>
    sliceBetween('async function runImportedRecap(', 'const transcript = settings.redactSensitive')

  it('consults the fallback gate, not only the useFor.summary gate', () => {
    const body = recap()
    expect(body).toMatch(/localFallbackEligibleFor\(\{ mode: 'summary' \}, settings, 'base', allowed\)/)
    expect(body).toMatch(/const localFallbackReady =\s*\n?\s*!localSummaryReady &&/)
  })

  it('orders a fallback-only local candidate strictly LAST, after every cloud/CLI provider', () => {
    expect(recap()).toMatch(
      /localFallbackReady\s*\n\s*\? \[\.\.\.deduped\.filter\(\(provider\) => provider !== 'local'\), 'local' as ProviderId\]/
    )
  })

  it('admits local to the candidate list under either gate', () => {
    expect(recap()).toMatch(/if \(provider === 'local'\) return localSummaryReady \|\| localFallbackReady/)
  })
})

describe('MQA-062 — a dead CLI session stops reporting itself as connected', () => {
  const onError = (): string =>
    sliceBetween('onError: (message) => {', 'win?.webContents.send(IPC.streamError, { id: req.id, message: friendly })')

  it('retires the CLI connection on the SAME pre-token seam that records the auth verdict', () => {
    // Must run before the pre-token failover line, or the very case that matters — a dead CLI silently
    // absorbed by another provider — never clears the flag. Deliberately a bare one-line call rather than
    // an inline block: local-cloud-boundary.contract.test.ts pins that failover line inside a fixed
    // 2600-char window from `onError:`, so this seam has only a few characters to spare. The reasoning
    // lives on retireCli at module scope.
    const body = onError()
    expect(body).toMatch(/if \(!gotToken\) retireCli\(provider, message\)/)
    expect(body.indexOf('retireCli(provider, message)')).toBeLessThan(
      body.indexOf("if (!gotToken && provider !== 'local' && failover(")
    )
  })

  it('clears cliConnected only for a CLI provider whose credentials were rejected, and only when set', () => {
    const helper = sliceBetween('function retireCli(', 'function publicSettings()')
    expect(helper).toMatch(/if \(PROVIDERS\[provider\]\.kind !== 'cli' \|\| !isAuthFailure\(message\)\) return/)
    expect(helper).toMatch(/if \(!s\.cliConnected\[provider\]\) return/)
    expect(helper).toMatch(/setSettings\(\{ cliConnected: \{ \.\.\.s\.cliConnected, \[provider\]: false \} \}\)/)
  })

  it('names the real remedy instead of sending CLI users to re-enter an API key they never had', () => {
    const body = onError()
    expect(body).toMatch(/def\.kind === 'cli' && isAuthFailure\(message\)\s*\n\s*\? `\$\{def\.label\} is no longer signed in\./)
    expect(body).toMatch(/Settings → CLI Integration/)
  })
})

describe('MQA-064 — a failed CRM key write reaches the user instead of wedging the card', () => {
  it('routes the thrown, user-authored diagnostic through the {ok,error} channel the card renders', () => {
    const handler = sliceBetween('ipcMain.handle(IPC.mcpCrmSaveConnection', 'ipcMain.handle(IPC.mcpCrmDisconnect')
    expect(handler).toMatch(/try \{\s*\n\s*setBidstackApiKey\(parsed\.data\.apiKey\)/)
    expect(handler).toMatch(/return \{ ok: false as const, error: error instanceof Error \? error\.message :/)
  })
})

describe('MQA-070 — turning encryption ON while publishing is on asks for the same consent', () => {
  const settingsSet = (): string => sliceBetween('ipcMain.handle(IPC.settingsSet', 'const next = setSettings(p)')

  it('gates the encryption OFF->ON edge, not only the publish OFF->ON edge', () => {
    const body = settingsSet()
    expect(body).toMatch(
      /if \(!publishConsentAsked && 'encryptTranscripts' in p && p\.encryptTranscripts && !wasEncrypted && willPublish\)/
    )
    expect(body).toMatch(/auditLog\('brain\.publish\.consent', \{ granted, at: 'encryption-enabled' \}\)/)
  })

  it('declining drops only encryptTranscripts — it never deletes the consented wiki as a side effect', () => {
    const body = settingsSet()
    expect(body).toMatch(/if \(!granted\) delete \(p as Record<string, unknown>\)\.encryptTranscripts/)
    expect(body).not.toMatch(/removeWiki/)
  })

  it('asks once when a single patch flips both toggles into that state', () => {
    const body = settingsSet()
    expect(body).toMatch(/let publishConsentAsked = false/)
    expect(body).toMatch(/publishConsentAsked = true/)
  })
})

describe('MQA-075 — the confidential flag reports the republish that actually enforces it', () => {
  const handler = (): string =>
    sliceBetween('ipcMain.handle(IPC.recallSetConfidential', 'ipcMain.handle(IPC.recallBackfillSpeakers')

  it('awaits publishAll inside the handler instead of detaching it', () => {
    const body = handler()
    expect(body).toMatch(/try \{\s*\n\s*await publishAll\(s\)\s*\n\s*\} catch \(error\) \{/)
    expect(body).not.toMatch(/void publishAll\(/)
  })

  it('stops asserting exclusion took effect when the republish failed', () => {
    expect(handler()).toMatch(/ok: false,\s*\n\s*error: 'Flag saved, but the published pages could not be updated/)
  })

  it('the sibling fire-and-forget republish in settingsSet can no longer fake a crash report', () => {
    expect(indexSrc).toMatch(/void publishAll\(next\)\.catch\(/)
  })
})

describe('MQA-081 — a wrong-monitor capture is flagged and keyed to the display it actually came from', () => {
  type ResolveCapture = (
    src: { display_id?: string },
    matched: { display_id?: string } | undefined,
    disp: { id: number }
  ) => { displayMismatch: boolean; dispId: number }
  const resolveCapture = (): ResolveCapture => {
    const block = sliceBetween("const capturedId = String(src.display_id ?? '')", 'return { image: jpeg.toString')
    return new Function('src', 'matched', 'disp', `${block}\nreturn { displayMismatch, dispId }`) as ResolveCapture
  }

  it('flags a lone surviving source that belongs to another monitor', () => {
    // getScreenSourcesWithRetry drops zero-pixel sources, so the cursor's own monitor can be filtered out
    // while another survives — the old `sources.length > 1` test read that as "necessarily correct".
    expect(resolveCapture()({ display_id: '11' }, undefined, { id: 22 })).toEqual({ displayMismatch: true, dispId: 11 })
  })

  it('does not flag a normal matched capture', () => {
    const src = { display_id: '22' }
    expect(resolveCapture()(src, src, { id: 22 })).toEqual({ displayMismatch: false, dispId: 22 })
  })

  it('does not invent a mismatch from a platform that reports no display id', () => {
    expect(resolveCapture()({ display_id: '' }, undefined, { id: 22 })).toEqual({ displayMismatch: false, dispId: 22 })
  })

  it('carries the flag out to the caller, through the cache as well as a fresh capture', () => {
    expect(indexSrc).toMatch(/type CapturedScreen = \{[^}]*displayMismatch: boolean/)
    expect(indexSrc).toMatch(/return \{ image, width, height, capturedAt: ts, displayMismatch \}/)
    expect(indexSrc).toMatch(/return \{ image, width, height, capturedAt, displayMismatch \}/)
  })

  it('keeps the "captured a different display" guard as a real check, not a tautology', () => {
    expect(indexSrc).toMatch(/if \(shot\.dispId !== disp\.id && !shot\.displayMismatch\)/)
  })
})

describe('MQA-090 — the hidden-window decoder reaps a finished job before refusing the next one', () => {
  it('mirrors the ffmpeg branch: a terminal job cannot block the next FIFO job with a false "already active"', () => {
    const beforeGuard = sliceBetween('  if (ffmpeg) {', '  if (decoderWin && !decoderWin.isDestroyed()) throw new Error')
    expect(beforeGuard).toMatch(
      /if \(decoderWin && !decoderWin\.isDestroyed\(\) && decoderJobId && decoderJobId !== job\.jobId\) \{/
    )
    expect(beforeGuard).toMatch(/const staleState = importJobs\?\.get\(decoderJobId\)\?\.state/)
    expect(beforeGuard).toMatch(/await closeImportDecoder\(decoderJobId\)/)
  })

  it('still refuses a genuinely live decoder', () => {
    const guard = sliceBetween('  if (decoderWin && !decoderWin.isDestroyed()) throw new Error', '  decoderJobId = job.jobId')
    expect(guard).toMatch(/Another audio decoder is already active\./)
  })
})
