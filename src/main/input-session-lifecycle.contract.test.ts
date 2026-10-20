import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const listenSource = readFileSync(join(__dirname, '../renderer/src/lib/listen.ts'), 'utf8')
const admissionSource = readFileSync(join(__dirname, '../renderer/src/lib/input-mic-admission.ts'), 'utf8')
const tapSource = readFileSync(join(__dirname, '../renderer/src/lib/tap/tap-control.ts'), 'utf8')
const tapCardSource = readFileSync(join(__dirname, '../renderer/src/features/settings/TapControlCard.tsx'), 'utf8')
const meetingCaptureAuthoritySource = readFileSync(join(__dirname, 'meeting-mic-capture-authority.ts'), 'utf8')
const quitLifecycleSource = readFileSync(join(__dirname, 'lifecycle/app-quit-lifecycle.ts'), 'utf8')

function declarationIn(sourceText: string, name: string): string {
  const start = sourceText.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(`Missing ${name} declaration`)
  const next = sourceText.indexOf('\nfunction ', start + 1)
  return sourceText.slice(start, next < 0 ? sourceText.length : next)
}

function declaration(name: string): string {
  return declarationIn(source, name)
}

function boundedBody(source: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = startPattern.exec(source)
  if (!start) throw new Error(`Missing source start boundary: ${startPattern}`)
  const bodyStart = start.index + start[0].length
  const remainder = source.slice(bodyStart)
  const end = endPattern.exec(remainder)
  if (!end) throw new Error(`Missing source end boundary after start: ${endPattern}`)
  const body = remainder.slice(0, end.index)
  if (!body.trim()) throw new Error('Expected a nonempty source body between boundaries')
  return body
}

type CallbackScope = { body: string; scope: string; start: number; end: number }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function boundedCallbackScopes(sourceText: string, startPattern: RegExp, callbackEndPattern?: RegExp): CallbackScope[] {
  const flags = startPattern.flags.includes('g') ? startPattern.flags : startPattern.flags + 'g'
  const matcher = new RegExp(startPattern.source, flags)
  const scopes: CallbackScope[] = []
  let start: RegExpExecArray | null
  while ((start = matcher.exec(sourceText)) !== null) {
    const bodyStart = start.index + start[0].length
    const indent = /^[\t ]*/.exec(start[0])?.[0] ?? ''
    const endPattern = callbackEndPattern ?? new RegExp('^' + escapeRegExp(indent) + '\\}[\\t ]*\\)', 'm')
    const remainder = sourceText.slice(bodyStart)
    const end = endPattern.exec(remainder)
    if (!end) throw new Error(`Missing callback end boundary after: ${startPattern}`)
    const body = remainder.slice(0, end.index)
    if (!body.trim()) throw new Error('Expected a nonempty callback body between boundaries')
    const endIndex = bodyStart + end.index + end[0].length
    scopes.push({ body, scope: sourceText.slice(start.index, endIndex), start: start.index, end: endIndex })
    matcher.lastIndex = endIndex
  }
  if (scopes.length === 0) throw new Error(`Missing callback registration: ${startPattern}`)
  return scopes
}

function requiredIndex(sourceText: string, token: string): number {
  const index = sourceText.indexOf(token)
  if (index < 0) throw new Error(`Missing source contract token: ${token}`)
  return index
}

function expectOrdered(sourceText: string, tokens: string[]): void {
  const positions = tokens.map((token) => requiredIndex(sourceText, token))
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1] ?? -1
    const current = positions[index] ?? -1
    expect(previous).toBeLessThan(current)
  }
}

function replaceOnce(sourceText: string, needle: string, replacement: string): string {
  sourceText = sourceText.replace(/\r\n/g, '\n')
  const start = sourceText.indexOf(needle)
  if (start < 0 || sourceText.indexOf(needle, start + needle.length) >= 0) {
    throw new Error('Expected one in-memory mutation boundary: ' + needle)
  }
  return sourceText.slice(0, start) + replacement + sourceText.slice(start + needle.length)
}

function expectRejectedSource(sourceText: string, assertContract: (text: string) => void): void {
  // Mutation construction happens before this assertion. A missing mutation boundary must fail the
  // test itself, rather than masquerading as a contract rejecting the intended broken production code.
  for (const lineEnding of ['\n', '\r\n']) {
    expect(() => assertContract(sourceText.replace(/\r?\n/g, lineEnding))).toThrow()
  }
}

function hasDirectStatement(scope: string, statement: string): boolean {
  const code = scope.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, ' '))
  const indent = /^[\t ]*(?=\S)/m.exec(code)?.[0] ?? ''
  return new RegExp('^' + escapeRegExp(indent) + escapeRegExp(statement) + '[\\t ]*;?[\\t ]*$', 'm').test(code)
}

function replaceInFailAdmittedCapture(sourceText: string, needle: string): string {
  const start = sourceText.indexOf('const failAdmittedCapture = useCallback(')
  if (start < 0) throw new Error('Missing failAdmittedCapture callback for in-memory mutation')
  const end = sourceText.indexOf('failAdmittedCaptureRef.current = failAdmittedCapture', start)
  if (end < 0) throw new Error('Missing forward failAdmittedCapture ref boundary for in-memory mutation')
  const callback = sourceText.slice(start, end)
  return sourceText.slice(0, start) + replaceOnce(callback, needle, '') + sourceText.slice(end)
}

function assertHiddenToggleShortcutContract(sourceText: string): void {
  sourceText = sourceText.replace(/\r\n/g, '\n')
  const shortcut = declarationIn(sourceText, 'sendHotkey')
  const hiddenToggle = boundedBody(
    shortcut,
    /if \(action === 'toggle-listen' && !listeningActive && !w\.isVisible\(\)\) \{\s*/,
    /\n[\t ]*\}[\t ]*\n[\t ]*if \(!w\.isVisible\(\) \|\| islandResting\)/
  )
  const routeAfterShow = boundedBody(
    hiddenToggle,
    /const routeAfterShow = \(\): void => \{\s*/,
    /\n[\t ]*\}[\t ]*\n[\t ]*w\.once\(\s*['"]show['"]/
  )
  const timeoutCleanup = boundedBody(hiddenToggle, /timeout = setTimeout\(\(\) => \{\s*/, /\n[\t ]*\},\s*1_000\)/)

  expect(sourceText).toMatch(/win\.on\(\s*['"]show['"]\s*,\s*revalidateInputSessionAfterShow\s*\)/)
  expect(sourceText).toMatch(/win\.on\(\s*['"]restore['"]\s*,\s*revalidateInputSessionAfterShow\s*\)/)
  expectOrdered(sourceText, [
    "win.on('show', revalidateInputSessionAfterShow)",
    "win.on('restore', revalidateInputSessionAfterShow)",
    'function sendHotkey('
  ])

  const showOnce = "w.once('show', routeAfterShow)"
  const restoreOnce = "w.once('restore', routeAfterShow)"
  const revealRequest = "reveal('hotkey', { focus: false })"
  const showOnceIndex = requiredIndex(hiddenToggle, showOnce)
  const restoreOnceIndex = requiredIndex(hiddenToggle, restoreOnce)
  const revealIndex = requiredIndex(hiddenToggle, revealRequest)
  expect(showOnceIndex).toBeLessThan(revealIndex)
  expect(restoreOnceIndex).toBeLessThan(revealIndex)
  expect(hiddenToggle).toMatch(/if \(!routed\)\s*\{[\s\S]*\}\s*return\s*$/)
  expectOrdered(hiddenToggle, [revealRequest, 'if (!routed)', 'timeout = setTimeout'])
  expect(hiddenToggle.lastIndexOf('return')).toBeGreaterThan(requiredIndex(hiddenToggle, 'timeout = setTimeout'))
  expectOrdered(timeoutCleanup, [
    'if (routed) return',
    "w.removeListener('show', routeAfterShow)",
    "w.removeListener('restore', routeAfterShow)"
  ])

  expectOrdered(routeAfterShow, [
    'if (routed) return',
    'if (w.isDestroyed() || !w.isVisible()) return',
    'routed = true',
    'if (timeout) clearTimeout(timeout)',
    "w.removeListener('show', routeAfterShow)",
    "w.removeListener('restore', routeAfterShow)",
    'if (listeningActive) return',
    'const frame = currentMainActivationFrame()',
    'if (!frame || !meetingStartActivationAuthority.mint(frame, MEETING_START_ACTION)) return',
    'w.webContents.send(IPC.hotkey, action)'
  ])
  expect(routeAfterShow.match(/meetingStartActivationAuthority\.mint\(frame, MEETING_START_ACTION\)/g)).toHaveLength(1)
}

function assertQuitLifecycleContract(quitLifecycle: string, mainSource: string): void {
  quitLifecycle = quitLifecycle.replace(/\r\n/g, '\n')
  mainSource = mainSource.replace(/\r\n/g, '\n')
  const beforeQuitHandlers = boundedCallbackScopes(
    quitLifecycle,
    /^[\t ]*app\.on\(\s*['"]before-quit['"]\s*,\s*\(event\)\s*=>\s*\{/gm
  )
  for (const handler of beforeQuitHandlers) {
    expect(handler.body).not.toContain('deps.shutdownInputSessions()')
    expect(handler.body).not.toContain('inputSessionAuthority.shutdown()')
  }

  const beginShutdownHandler = beforeQuitHandlers.find((handler) => handler.body.includes('deps.beginInputShutdown()'))
  if (!beginShutdownHandler) throw new Error('Missing before-quit beginInputShutdown callback')
  expectOrdered(beginShutdownHandler.body, ['deps.beginInputShutdown()', 'deps.speechPackDesktop()?.beforeQuit'])

  const flushHandler = beforeQuitHandlers.find((handler) => handler.body.includes('setTimeout(() => app.quit(), 2000)'))
  if (!flushHandler) throw new Error('Missing before-quit live-meeting flush/resume handler')
  expectOrdered(flushHandler.body, [
    'deps.isQuitFlushDone()',
    'deps.meetingFlushPending()',
    'event.preventDefault()',
    'deps.markQuitFlushDone()',
    "window.webContents.send(deps.hotkeyChannel, 'reset')",
    'setTimeout(() => app.quit(), 2000)'
  ])

  const willQuitHandlers = boundedCallbackScopes(
    quitLifecycle,
    /^[\t ]*app\.on\(\s*['"]will-quit['"]\s*,\s*deps\.wrapLifecycleListener\(\s*['"]app_quit['"]\s*,\s*\(\)\s*=>\s*\{/gm,
    /^[\t ]*\}[\t ]*\)\r?\n[\t ]*\)/m
  )
  expect(willQuitHandlers).toHaveLength(1)
  const willQuitHandler = willQuitHandlers[0]
  if (!willQuitHandler) throw new Error('Missing bounded will-quit callback')
  expect(willQuitHandler.scope).toMatch(/app\.on\(\s*['"]will-quit['"]\s*,\s*deps\.wrapLifecycleListener\s*\(/s)
  expect(hasDirectStatement(willQuitHandler.body, 'deps.shutdownInputSessions()')).toBe(true)
  expect(willQuitHandler.start).toBeGreaterThan(Math.max(...beforeQuitHandlers.map((handler) => handler.end)))

  const beginBinding = boundedBody(
    mainSource,
    /beginInputShutdown:\s*\(\)\s*=>\s*\{\s*/,
    /\n[\t ]*\},\s*\n[\t ]*quitTrace/
  )
  expect(beginBinding).toContain('inputSessionAuthority.beginShutdown()')
  const shutdownBinding = boundedBody(
    mainSource,
    /shutdownInputSessions:\s*\(\)\s*=>\s*\{\s*/,
    /\n[\t ]*\},\s*\n[\t ]*setBootPowerSaveBlock/
  )
  expectOrdered(shutdownBinding, ["hardStopInputSession('shutdown')", 'inputSessionAuthority.shutdown()'])

  const transition = declarationIn(mainSource, 'acceptLiveSpeakerTransition')
  expectOrdered(transition, [
    'if (change.on && (inputSessionAuthority.isClosing || !inputPowerLifecycleHooksReady)) return false',
    "hardStopMeetingCapture('owner-replaced')"
  ])
  // The meeting-start activation handlers are covered behaviorally in ipc/meeting-mic-ipc.test.ts.
  expect(mainSource).toContain('activation: meetingStartActivationAuthority')
  expect(mainSource).toContain('isInputClosing: () => inputSessionAuthority.isClosing')
  expect(mainSource).toContain('isMainWindowVisible: () => !!win && !win.isDestroyed() && win.isVisible()')
}

function failAdmittedCaptureBody(listenSourceText: string): string {
  return boundedBody(
    listenSourceText,
    /const failAdmittedCapture = useCallback\(/,
    /failAdmittedCaptureRef\.current\s*=\s*failAdmittedCapture/
  )
}

function meetingRevocationBody(listenSourceText: string): string {
  return boundedBody(
    listenSourceText,
    /window\.toto\.onMeetingMicCaptureRevoked\(\s*\(event\)\s*=>\s*\{\s*/,
    /\}\s*\)\s*,\s*\[\s*failAdmittedCapture\s*\]\s*\)/
  )
}

function assertForcedRendererTeardownContract(listenSourceText: string): void {
  listenSourceText = listenSourceText.replace(/\r\n/g, '\n')
  const failure = failAdmittedCaptureBody(listenSourceText)
  expect(failure).toContain('if (!options.force && !captureSessionIsOpen(sessionEpochRef.current)) return')
  const forcedTeardown = boundedBody(failure, /if \(options\.force\)\s*\{\s*/, /\n[\t ]*\}\n[\t ]*const brokerCapture/)
  expectOrdered(forcedTeardown, [
    'sessionEpochRef.current += 1',
    'if (drainTimerRef.current) clearTimeout(drainTimerRef.current)',
    'drainTimerRef.current = null',
    'const activeStop = stopDrainRef.current',
    "activeStop.phase = 'finished'",
    "settleStopCallbacks(activeStop, 'revoked')",
    'stopDrainRef.current = null',
    'workerRef.current?.terminate()'
  ])
  expect(failure).toContain('queue.current = []')
  expect(failure).toContain("for (const speaker of ['you', 'them'] as const) closeChannel(speaker)")
  expectOrdered(failure, [
    'queue.current = []',
    "for (const speaker of ['you', 'them'] as const) closeChannel(speaker)",
    'releaseBrokerRetainedCapture(capture)',
    'brokerRetainedStreamsRef.current = {}'
  ])

  const brokerCleanup = boundedBody(failure, /if \(brokerCapture\)\s*\{\s*/, /\n[\t ]*\}\n[\t ]*activeMicTrackRef/)
  expect(brokerCleanup).toContain('brokerController.cancel()')
  expect(brokerCleanup).toContain('brokerController.dispose()')
  expect(brokerCleanup).toContain('activeBrokerSpeechRef.current = null')

  const revocation = meetingRevocationBody(listenSourceText)
  expectOrdered(revocation, [
    'if (event.startedAt !== sessionStartedAtRef.current) return',
    "if (event.reason === 'user-stop')"
  ])
  const userStopBranch = boundedBody(
    revocation,
    /if \(event\.reason === 'user-stop'\) \{/,
    /\n[\t ]*\}[\t ]*\n[\t ]*\/\/ Main has already invalidated this exact meeting reservation/
  )
  expect(hasDirectStatement(userStopBranch, 'return')).toBe(true)
  const revokeCallIndex = requiredIndex(revocation, "failAdmittedCapture('Meeting microphone admission was revoked.'")
  expect(requiredIndex(revocation, "if (event.reason === 'user-stop')")).toBeLessThan(revokeCallIndex)
  const revokeCall = boundedBody(
    revocation,
    /failAdmittedCapture\(\s*'Meeting microphone admission was revoked\.'\s*,\s*\{\s*/,
    /\}\s*\)/
  )
  expect(revokeCall).toContain('force: true')
  expect(revokeCall).toContain('forceCloudStop: true')
}

it.each(['\n', '\r\n'])('accepts lifecycle source contracts with %j line endings', (lineEnding) => {
  const checkoutText = (text: string): string => text.replace(/\r?\n/g, lineEnding)
  assertHiddenToggleShortcutContract(checkoutText(source))
  assertQuitLifecycleContract(checkoutText(quitLifecycleSource), checkoutText(source))
  assertForcedRendererTeardownContract(checkoutText(listenSource))
})

describe('input-session lifecycle revocation wiring', () => {
  it('hard-stops before same-WebContents renderer reload', () => {
    const body = declaration('reloadOverlay')
    expect(body.indexOf("hardStopInputSession('owner-replaced')")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("hardStopInputSession('owner-replaced')")).toBeLessThan(body.indexOf('target.loadURL('))
  })

  it('hard-stops before opaque overlay destruction or replacement', () => {
    const recreation = declaration('recreateOverlayWindow')
    expect(recreation.indexOf("hardStopInputSession('owner-replaced')")).toBeLessThan(
      recreation.indexOf('dying.destroy()')
    )
    const opaque = declaration('replaceTransparentOverlayWithExclusiveOnboarding')
    expect(opaque.indexOf("hardStopInputSession('owner-replaced')")).toBeLessThan(
      opaque.indexOf('createWindow(replacementDisplay)')
    )
  })

  it('hard-stops only on a replacing main-frame navigation, not an in-place hash change', () => {
    expect(source).toMatch(
      /did-start-navigation',\s*\(_event,\s*_url,\s*isInPlace,\s*isMainFrame\)\s*=>\s*\{\s*if\s*\(win === self && isMainFrame && !isInPlace\) hardStopInputSession\('owner-replaced'\)/
    )
  })

  it('hard-stops when auth clears through expiry or tenant revocation', () => {
    const body = declaration('revokePrivilegedSurface')
    expect(body.indexOf("hardStopInputSession('auth-revoked')")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("hardStopInputSession('auth-revoked')")).toBeLessThan(body.indexOf('refreshScreenPreprocess()'))
  })

  it('revokes interactive and meeting microphone capture on system suspend and screen lock', () => {
    const installHooks = declaration('installInputPowerLifecycleHooks')
    expect(installHooks).toContain("powerMonitor.on('suspend', () => hardStopInputSession('system-suspend'))")
    expect(installHooks).toContain("powerMonitor.on('lock-screen', () => hardStopInputSession('screen-locked'))")
    expect(installHooks).toContain('inputPowerLifecycleHooksReady = suspendRegistered && lockScreenRegistered')
    expect(installHooks).toContain('if (!inputPowerLifecycleHooksReady)')
    expect(source).toContain('isCaptureLifecycleReady: () => inputPowerLifecycleHooksReady')
    expect(source).toContain('inputSessionAuthority.isClosing || !inputPowerLifecycleHooksReady')
    const hardStop = declaration('hardStopInputSession')
    expect(hardStop).toContain("reason === 'system-suspend'")
    expect(hardStop).toContain("reason === 'screen-locked'")
    expect(hardStop).toContain('hardStopMeetingCapture(reason)')
  })

  it('routes hidden-window shortcut starts only after show/restore revalidation', () => {
    assertHiddenToggleShortcutContract(source)

    const restoreRegistration = "    w.once('restore', routeAfterShow)\n"
    expectRejectedSource(replaceOnce(source, restoreRegistration, ''), assertHiddenToggleShortcutContract)

    const registrations =
      "    w.once('show', routeAfterShow)\n" +
      "    w.once('restore', routeAfterShow)\n" +
      "    reveal('hotkey', { focus: false })"
    const reorderedRegistrations =
      "    reveal('hotkey', { focus: false })\n" +
      "    w.once('show', routeAfterShow)\n" +
      "    w.once('restore', routeAfterShow)"
    expectRejectedSource(replaceOnce(source, registrations, reorderedRegistrations), assertHiddenToggleShortcutContract)

    const mintThenSend =
      '      if (!frame || !meetingStartActivationAuthority.mint(frame, MEETING_START_ACTION)) return\n' +
      '      w.webContents.send(IPC.hotkey, action)'
    const sendThenMint =
      '      w.webContents.send(IPC.hotkey, action)\n' +
      '      if (!frame || !meetingStartActivationAuthority.mint(frame, MEETING_START_ACTION)) return'
    expectRejectedSource(replaceOnce(source, mintThenSend, sendThenMint), assertHiddenToggleShortcutContract)
  })

  it('revokes unused meeting-start grants on each accepted Listen stop path', () => {
    const transition = declaration('acceptLiveSpeakerTransition')
    expect(transition).toMatch(
      /if \(change\.on === legacyListeningActive\) return false[\s\S]*?\} else \{\s*meetingStartActivationAuthority\.revokeAll\(\)/
    )
    expect(transition).toMatch(
      /if \(activeLiveSpeakerStartedAt !== startedAt\) return false\s*meetingStartActivationAuthority\.revokeAll\(\)/
    )
  })

  it('permanently shuts admission only at final will-quit after before-quit flush gates', () => {
    const quitLifecycle = quitLifecycleSource
    assertQuitLifecycleContract(quitLifecycle, source)

    const beginBeforeQuit = '    deps.beginInputShutdown()\n    }\n    deps.speechPackDesktop()?.beforeQuit'
    const shutdownBeforeFinalQuit =
      '    deps.beginInputShutdown()\n' +
      '      deps.shutdownInputSessions()\n' +
      '    }\n' +
      '    deps.speechPackDesktop()?.beforeQuit'
    const assertQuit = (text: string): void => assertQuitLifecycleContract(text, source)
    expectRejectedSource(replaceOnce(quitLifecycle, beginBeforeQuit, shutdownBeforeFinalQuit), assertQuit)

    expectRejectedSource(
      replaceOnce(quitLifecycle, '      deps.shutdownInputSessions()\n', '      // deps.shutdownInputSessions()\n'),
      assertQuit
    )

    expectRejectedSource(
      replaceOnce(
        quitLifecycle,
        '      deps.shutdownInputSessions()\n',
        '      setTimeout(() => deps.shutdownInputSessions(), 0)\n'
      ),
      assertQuit
    )

    expectRejectedSource(
      replaceOnce(
        quitLifecycle,
        '      deps.shutdownInputSessions()\n',
        '      /*\n      deps.shutdownInputSessions()\n      */\n'
      ),
      assertQuit
    )
  })

  it('forces full renderer teardown when meeting revocation arrives during Stop drain', () => {
    assertForcedRendererTeardownContract(listenSource)

    const withoutForwardBoundary = replaceOnce(
      listenSource,
      '  failAdmittedCaptureRef.current = failAdmittedCapture\n',
      ''
    )
    expectRejectedSource(withoutForwardBoundary, assertForcedRendererTeardownContract)

    const forceAndCloudStop = '          force: true,\n          forceCloudStop: true,'
    const noForcedRevocation = '          force: false,\n          forceCloudStop: true,'
    expectRejectedSource(
      replaceOnce(listenSource, forceAndCloudStop, noForcedRevocation),
      assertForcedRendererTeardownContract
    )

    for (const token of [
      'sessionEpochRef.current += 1',
      'workerRef.current?.terminate()',
      "for (const speaker of ['you', 'them'] as const) closeChannel(speaker)",
      'queue.current = []'
    ]) {
      expectRejectedSource(replaceInFailAdmittedCapture(listenSource, token), assertForcedRendererTeardownContract)
    }

    expectRejectedSource(
      replaceOnce(
        listenSource,
        '          return\n        }\n        // Main has already invalidated this exact meeting reservation.',
        '          // return\n        }\n        // Main has already invalidated this exact meeting reservation.'
      ),
      assertForcedRendererTeardownContract
    )

    expectRejectedSource(
      replaceOnce(
        listenSource,
        '          return\n        }\n        // Main has already invalidated this exact meeting reservation.',
        '          /*\n          return\n          */\n        }\n' +
          '        // Main has already invalidated this exact meeting reservation.'
      ),
      assertForcedRendererTeardownContract
    )
  })

  it('revokes pending and permission-authorized meeting grants while retaining established streams', () => {
    const pendingStart = meetingCaptureAuthoritySource.indexOf('revokePending(')
    const pendingEnd = meetingCaptureAuthoritySource.indexOf('#frameMatchesCurrentMain(', pendingStart)
    const pendingRevocation = meetingCaptureAuthoritySource.slice(pendingStart, pendingEnd)
    expect(pendingRevocation).toContain("if (owner.state === 'established') continue")
    expect(pendingRevocation).toContain('this.#revoke(captureId, owner, reason)')
    expect(meetingCaptureAuthoritySource).toContain("'pending' | 'permission-authorized' | 'established'")

    const hideHandler = source.slice(
      source.indexOf("win.on('hide'"),
      source.indexOf('const revalidateInputSessionAfterShow')
    )
    expect(hideHandler).toContain("revokePendingMeetingMicCaptureGrants('window-hidden')")

    const showStart = source.indexOf('const revalidateInputSessionAfterShow')
    const showEnd = source.indexOf("win.on('show', revalidateInputSessionAfterShow)", showStart)
    const showHandler = source.slice(showStart, showEnd)
    expect(showHandler).toContain("hardStopInputSession('cancelled')")
    expect(showHandler).toContain("revokePendingMeetingMicCaptureGrants('cancelled')")
    expect(pendingRevocation).toContain("if (owner.state === 'established') continue")

    const confirmStart = meetingCaptureAuthoritySource.indexOf('confirm(frame:')
    const releaseStart = meetingCaptureAuthoritySource.indexOf('release(webContentsId:', confirmStart)
    const confirmHandler = meetingCaptureAuthoritySource.slice(confirmStart, releaseStart)
    expect(confirmHandler).toContain("owner.state !== 'permission-authorized'")
    expect(confirmHandler).toContain('owner.startedAt !== startedAt')
    expect(confirmHandler).toContain('owner.webContentsId !== frame.webContentsId')
    expect(confirmHandler).toContain('owner.authSessionGeneration !== current.context.authSessionGeneration')
    expect(confirmHandler).toContain('owner.contextRevision !== current.context.contextRevision')
    expect(confirmHandler).toContain('owner.requestingUrl !== current.currentUrl')
    expect(confirmHandler).toContain('!current.isWindowVisible')
    expect(confirmHandler).toContain("owner.state = 'established'")
  })

  it('binds meeting grants to the accepted reservation and limits release to the exact sender-owned id', () => {
    // The IPC admission, confirm, and release handlers are covered behaviorally in ipc/meeting-mic-ipc.test.ts.
    expect(source).toContain('capture: meetingMicCaptureAuthority')
    const admitStart = meetingCaptureAuthoritySource.indexOf('admit(frame:')
    const confirmMethodStart = meetingCaptureAuthoritySource.indexOf('confirm(frame:', admitStart)
    const admit = meetingCaptureAuthoritySource.slice(admitStart, confirmMethodStart)
    expect(admit).toContain('current.meetingStartedAt !== startedAt')
    expect(admit).toContain("state: 'pending'")
    expect(admit).toContain('authSessionGeneration: current.context.authSessionGeneration')
    expect(admit).toContain('contextRevision: current.context.contextRevision')
    expect(admit).toContain('requestingUrl: current.currentUrl')
    expect(source).toContain(
      'meetingMicCaptureAuthority.hasPermissionRequestOwner(webContentsId, startedAt, context, requestingUrl)'
    )
    expect(source).toContain(
      'meetingMicCaptureAuthority.hasPermissionCheckOwner(webContentsId, startedAt, context, requestingUrl)'
    )

    const releaseMethodStart = meetingCaptureAuthoritySource.indexOf('release(webContentsId:')
    const pendingMethodStart = meetingCaptureAuthoritySource.indexOf('hasPermissionCheckOwner(', releaseMethodStart)
    const releaseMethod = meetingCaptureAuthoritySource.slice(releaseMethodStart, pendingMethodStart)
    expect(releaseMethod).toContain('owner.webContentsId !== webContentsId')
    expect(releaseMethod).toContain('this.#owners.delete(captureId)')
    // Release remains cleanup-only after reservation replacement; it cannot mutate the meeting reservation.
    expect(releaseMethod).not.toContain('meetingStartedAt')
    expect(releaseMethod).not.toContain('reserveMeeting(')
  })

  it('ignores delayed user-stop grant revocation after graceful Listen stop', () => {
    const listener = boundedBody(
      listenSource,
      /useEffect\s*\(\s*\(\)\s*=>\s*window\.toto\.onMeetingMicCaptureRevoked\s*\(\s*\(\s*event\s*\)\s*=>\s*\{\s*/,
      /\}\s*\)\s*,\s*\[\s*failAdmittedCapture\s*\]\s*\)/
    )
    const userStopGuard = listener.indexOf("if (event.reason === 'user-stop')")
    const failAdmittedCapture = listener.indexOf('failAdmittedCapture(')
    const forcedCloudStop = listener.indexOf('forceCloudStop: true')
    expect(userStopGuard).toBeGreaterThanOrEqual(0)
    expect(failAdmittedCapture).toBeGreaterThanOrEqual(0)
    expect(forcedCloudStop).toBeGreaterThanOrEqual(0)
    expect(userStopGuard).toBeLessThan(failAdmittedCapture)
    expect(forcedCloudStop).toBeGreaterThan(failAdmittedCapture)
  })

  it('makes pending interactive capture abortable and releases on devicechange', () => {
    expect(admissionSource).toContain("signal?.addEventListener('abort', onAbort")
    expect(admissionSource).toMatch(/const onDeviceChange = \(\): void => \{\s*void admission\.release\(\)\s*\}/)
    expect(admissionSource.match(/record\.cleanups\.add\(detachListeners\)/g)).toHaveLength(2)
    expect(admissionSource).toContain('if (released || record.revoked)')
    expect(listenSource).toContain('micAcquisitionAbortRef.current?.abort()')
    expect(tapSource).toContain('signal: acquisitionAbort.signal')
    expect(tapSource).toContain('acquisitionAbortRef.current?.abort()')
    expect(tapCardSource).toContain('signal: captureAbort.signal')
    expect(tapCardSource).toContain('captureAbortRef.current?.abort()')
  })
})
