import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const listenSource = readFileSync(join(__dirname, '../renderer/src/lib/listen.ts'), 'utf8')
const admissionSource = readFileSync(join(__dirname, '../renderer/src/lib/input-mic-admission.ts'), 'utf8')
const tapSource = readFileSync(join(__dirname, '../renderer/src/lib/tap/tap-control.ts'), 'utf8')
const tapCardSource = readFileSync(join(__dirname, '../renderer/src/features/settings/TapControlCard.tsx'), 'utf8')
const meetingCaptureAuthoritySource = readFileSync(join(__dirname, 'meeting-mic-capture-authority.ts'), 'utf8')

function declaration(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`Missing ${name} declaration`)
  const next = source.indexOf('\nfunction ', start + 1)
  return source.slice(start, next < 0 ? source.length : next)
}

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
    expect(source).toContain('inputSessionAuthority.isClosing || !inputPowerLifecycleHooksReady) return null')
    const hardStop = declaration('hardStopInputSession')
    expect(hardStop).toContain("reason === 'system-suspend'")
    expect(hardStop).toContain("reason === 'screen-locked'")
    expect(hardStop).toContain('hardStopMeetingCapture(reason)')
  })

  it('routes hidden-window shortcut starts only after show/restore revalidation', () => {
    const persistentShowRevalidation = source.indexOf("win.on('show', revalidateInputSessionAfterShow)")
    const shortcut = declaration('sendHotkey')
    const showSubscription = shortcut.indexOf("w.once('show', routeAfterShow)")
    const revealRequest = shortcut.indexOf("reveal('hotkey', { focus: false })")
    const grantMint = shortcut.indexOf('meetingStartActivationAuthority.mint(frame, MEETING_START_ACTION)')
    const routeSend = shortcut.indexOf('w.webContents.send(IPC.hotkey, action)')

    expect(persistentShowRevalidation).toBeGreaterThanOrEqual(0)
    expect(showSubscription).toBeGreaterThanOrEqual(0)
    expect(persistentShowRevalidation).toBeLessThan(source.indexOf('function sendHotkey('))
    expect(showSubscription).toBeLessThan(revealRequest)
    expect(revealRequest).toBeLessThan(grantMint)
    expect(grantMint).toBeLessThan(routeSend)
    expect(shortcut.slice(shortcut.indexOf('const routeAfterShow'), showSubscription)).toContain(
      'if (w.isDestroyed() || !w.isVisible()) return'
    )
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
    const quitLifecycle = readFileSync(join(__dirname, 'lifecycle/app-quit-lifecycle.ts'), 'utf8')
    expect(quitLifecycle.indexOf("app.on('will-quit'")).toBeGreaterThanOrEqual(0)
    expect(quitLifecycle.indexOf('deps.shutdownInputSessions()')).toBeGreaterThan(
      quitLifecycle.indexOf("app.on('will-quit'")
    )
    expect(quitLifecycle.indexOf('deps.shutdownInputSessions()')).toBeGreaterThan(
      quitLifecycle.indexOf('setTimeout(() => app.quit(), 2000)')
    )
    expect(source).toMatch(
      /shutdownInputSessions:\s*\(\)\s*=>\s*\{[\s\S]*?hardStopInputSession\('shutdown'\)[\s\S]*?inputSessionAuthority\.shutdown\(\)/
    )
    expect(quitLifecycle.indexOf('deps.beginInputShutdown()')).toBeGreaterThan(
      quitLifecycle.indexOf("app.on('before-quit'")
    )
    expect(source).toContain('inputSessionAuthority.beginShutdown()')
    const transition = declaration('acceptLiveSpeakerTransition')
    expect(transition.indexOf('if (change.on && inputSessionAuthority.isClosing) return false')).toBeGreaterThanOrEqual(
      0
    )
    expect(transition.indexOf('if (change.on && inputSessionAuthority.isClosing) return false')).toBeLessThan(
      transition.indexOf("hardStopMeetingCapture('owner-replaced')")
    )
    expect(source).toContain('inputSessionAuthority.isClosing || !requireAuth()')
  })

  it('forces full renderer teardown when meeting revocation arrives during Stop drain', () => {
    expect(listenSource).toMatch(/onMeetingMicCaptureRevoked\([\s\S]*?failAdmittedCapture\([^;]+force:\s*true/)
    const forcedFailure = listenSource.slice(
      listenSource.indexOf('const failAdmittedCapture = useCallback'),
      listenSource.indexOf('failAdmittedCaptureRef.current')
    )
    expect(forcedFailure).toContain('sessionEpochRef.current += 1')
    expect(forcedFailure).toContain('workerRef.current?.terminate()')
    expect(forcedFailure).toContain('closeChannel(speaker)')
    expect(forcedFailure).toContain('queue.current = []')
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
    const admissionStart = source.indexOf('ipcMain.handle(IPC.meetingMicAdmission')
    const confirmStart = source.indexOf('ipcMain.handle(IPC.meetingMicCaptureConfirm', admissionStart)
    const admission = source.slice(admissionStart, confirmStart)
    expect(admission.indexOf('assertMainWindow(event)')).toBeLessThan(
      admission.indexOf('meetingMicCaptureAuthority.admit(')
    )
    expect(admission).toContain('meetingMicCaptureAuthority.admit(')
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

    const releaseStart = source.indexOf('ipcMain.handle(IPC.meetingMicCaptureRelease', confirmStart)
    const releaseEnd = source.indexOf('ipcMain.handle(', releaseStart + 1)
    const release = source.slice(releaseStart, releaseEnd)
    expect(release.indexOf('assertMainWindow(event)')).toBeLessThan(
      release.indexOf('meetingMicCaptureAuthority.release(')
    )
    expect(release).toContain('meetingMicCaptureAuthority.release(event.sender.id, parsed.data.captureId)')
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
    const start = listenSource.indexOf('useEffect(() => window.toto.onMeetingMicCaptureRevoked')
    const end = listenSource.indexOf('}), [failAdmittedCapture])', start)
    const listener = listenSource.slice(start, end)
    expect(listener.indexOf("if (event.reason === 'user-stop')")).toBeGreaterThanOrEqual(0)
    expect(listener.indexOf("if (event.reason === 'user-stop')")).toBeLessThan(listener.indexOf('failAdmittedCapture('))
    expect(listener.indexOf('forceCloudStop: true')).toBeGreaterThan(listener.indexOf('failAdmittedCapture('))
  })

  it('makes pending interactive capture abortable and releases on devicechange', () => {
    expect(admissionSource).toContain("signal?.addEventListener('abort', onAbort")
    expect(admissionSource).toContain('const onDeviceChange = (): void => { void admission.release() }')
    expect(admissionSource.match(/record\.cleanups\.add\(detachListeners\)/g)).toHaveLength(2)
    expect(admissionSource).toContain('if (released || record.revoked)')
    expect(listenSource).toContain('micAcquisitionAbortRef.current?.abort()')
    expect(tapSource).toContain('signal: acquisitionAbort.signal')
    expect(tapSource).toContain('acquisitionAbortRef.current?.abort()')
    expect(tapCardSource).toContain('signal: captureAbort.signal')
    expect(tapCardSource).toContain('captureAbortRef.current?.abort()')
  })
})
