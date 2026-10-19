import { describe, expect, it, vi } from 'vitest'
import { InputSessionAuthority } from './input-session-authority'
import { installInputMicPermissionHandlers } from './input-mic-permissions'

type RequestHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>

const CURRENT_URL = 'https://metis.example/app/index.html'
const CURRENT_ORIGIN = 'https://metis.example'

function fixture(options: {
  lease?: boolean
  meeting?: boolean
  meetingGrant?: boolean
  meetingGrantState?: 'pending' | 'permission-authorized' | 'established'
  existingPermission?: boolean
  lifecycleReady?: boolean
} = {}): {
  authority: InputSessionAuthority
  request: RequestHandler
  check: CheckHandler
  webContents: Electron.WebContents
  setVisible(value: boolean): void
  setAuthenticated(value: boolean): void
  setUrl(value: string): void
  setFrame(value: { parent: Electron.WebFrameMain | null; url: string }): void
  setContext(value: { authSessionGeneration: number; contextRevision: number }): void
  meetingClaimCalls(): number
} {
  let visible = true
  let authenticated = true
  let url = CURRENT_URL
  let frame: { parent: Electron.WebFrameMain | null; url: string } = { parent: null, url: CURRENT_URL }
  const webContents = {
    id: 41,
    getURL: () => url,
    get mainFrame() { return frame }
  } as unknown as Electron.WebContents
  const browserWindow = {
    webContents,
    isDestroyed: () => false,
    isVisible: () => visible
  } as unknown as Electron.BrowserWindow
  const authority = new InputSessionAuthority({ token: () => 'a'.repeat(48) })
  let context = { authSessionGeneration: 4, contextRevision: 9 }
  const meetingGrantContext = { ...context }
  const meetingGrantUrl = CURRENT_URL
  let meetingGrantState = options.meetingGrant === true ? options.meetingGrantState ?? 'pending' : null
  let meetingClaimCalls = 0
  if (options.lease !== false) {
    const result = authority.start({
      webContentsId: webContents.id,
      frameId: 'main-frame-41',
      isTopFrame: true,
      ...context
    }, { source: 'deliberate-talk', purpose: 'conversation', activation: 'explicit' })
    if (!result.ok) throw new Error('test input lease did not start')
  }
  if (options.meeting && !authority.reserveMeeting(654)) throw new Error('test meeting reservation did not start')
  const registeredRequestHandlers: RequestHandler[] = []
  const registeredCheckHandlers: CheckHandler[] = []
  const session = {
    setPermissionRequestHandler: vi.fn((handler: RequestHandler | null) => {
      if (handler) registeredRequestHandlers.push(handler)
    }),
    setPermissionCheckHandler: vi.fn((handler: CheckHandler | null) => {
      if (handler) registeredCheckHandlers.push(handler)
    })
  } as unknown as Pick<Electron.Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>
  installInputMicPermissionHandlers({
    session,
    getWindow: () => browserWindow,
    isAuthenticated: () => authenticated,
    isCaptureLifecycleReady: () => options.lifecycleReady !== false,
    currentContext: () => context,
    authority,
    hasMeetingCaptureRequestOwner: (webContentsId, startedAt, current, requestingUrl) =>
      meetingGrantState === 'pending' &&
      webContentsId === webContents.id && startedAt === 654 &&
      current.authSessionGeneration === meetingGrantContext.authSessionGeneration &&
      current.contextRevision === meetingGrantContext.contextRevision && requestingUrl === meetingGrantUrl,
    hasMeetingCaptureCheckOwner: (webContentsId, startedAt, current, requestingUrl) =>
      meetingGrantState === 'permission-authorized' &&
      webContentsId === webContents.id && startedAt === 654 &&
      current.authSessionGeneration === meetingGrantContext.authSessionGeneration &&
      current.contextRevision === meetingGrantContext.contextRevision && requestingUrl === meetingGrantUrl,
    claimMeetingCapturePermission: (requestFrame) => {
      if (meetingGrantState !== 'pending' || requestFrame.webContentsId !== webContents.id || !requestFrame.isTopFrame || requestFrame.url !== meetingGrantUrl ||
          authority.meetingStartedAt !== 654 || context.authSessionGeneration !== meetingGrantContext.authSessionGeneration ||
          context.contextRevision !== meetingGrantContext.contextRevision) return false
      meetingGrantState = 'permission-authorized'
      meetingClaimCalls += 1
      return true
    },
    claimInteractiveCapturePermission: (owner) => authority.claimPermissionRequest(owner),
    allowExistingPermission: (wc, permission) =>
      options.existingPermission !== false && wc === webContents && (permission === 'media' || permission === 'clipboard-sanitized-write')
  })
  const requestHandler = registeredRequestHandlers.at(-1)
  const checkHandler = registeredCheckHandlers.at(-1)
  if (!requestHandler || !checkHandler) throw new Error('permission handlers were not registered')

  return {
    authority,
    request: requestHandler,
    check: checkHandler,
    webContents,
    setVisible(value) { visible = value },
    setAuthenticated(value) { authenticated = value },
    setUrl(value) { url = value },
    setFrame(value) { frame = value },
    setContext(value) { context = value },
    meetingClaimCalls() { return meetingClaimCalls }
  }
}

function audioRequest(overrides: Partial<Electron.MediaAccessPermissionRequest> = {}): Electron.MediaAccessPermissionRequest {
  return {
    mediaTypes: ['audio'],
    securityOrigin: CURRENT_ORIGIN,
    requestingUrl: CURRENT_URL,
    isMainFrame: true,
    ...overrides
  }
}

function permissionRequest(
  env: ReturnType<typeof fixture>,
  permission: Parameters<RequestHandler>[1],
  details: Parameters<RequestHandler>[3]
): boolean | undefined {
  let allowed: boolean | undefined
  env.request(env.webContents, permission, (value) => { allowed = value }, details)
  return allowed
}

describe('main microphone permission request gate', () => {
  it('allows admitted visible authenticated top-frame audio and preserves video/clipboard behavior', () => {
    const env = fixture()
    expect(permissionRequest(env, 'media', audioRequest())).toBe(true)
    expect(permissionRequest(env, 'media', audioRequest({ mediaTypes: ['video'] }))).toBe(true)
    expect(permissionRequest(env, 'clipboard-sanitized-write', {
      requestingUrl: CURRENT_URL,
      isMainFrame: true
    })).toBe(true)
  })

  it('atomically claims one interactive request and denies another until exact capture confirmation', () => {
    const env = fixture()
    expect(env.check(env.webContents, 'media', CURRENT_ORIGIN, {
      mediaType: 'audio', requestingUrl: CURRENT_URL, isMainFrame: true
    })).toBe(false)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(true)
    // The permission-check callback is read-only and remains usable while getUserMedia resolves.
    expect(env.check(env.webContents, 'media', CURRENT_ORIGIN, {
      mediaType: 'audio', requestingUrl: CURRENT_URL, isMainFrame: true
    })).toBe(true)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(false)
    expect(env.authority.confirmCapture({
      webContentsId: env.webContents.id,
      frameId: 'main-frame-41',
      isTopFrame: true,
      authSessionGeneration: 4,
      contextRevision: 9
    }, env.authority.activeLease!.sessionId)).toBe(true)
    expect(env.check(env.webContents, 'media', CURRENT_ORIGIN, {
      mediaType: 'audio', requestingUrl: CURRENT_URL, isMainFrame: true
    })).toBe(false)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(false)
  })

  it('allows an accepted meeting only when its exact renderer has an active capture grant', () => {
    expect(permissionRequest(fixture({ lease: false, meeting: true, meetingGrant: true }), 'media', audioRequest())).toBe(true)
    expect(permissionRequest(fixture({ lease: false, meeting: true, meetingGrant: false }), 'media', audioRequest())).toBe(false)
  })

  it('accepts only a pending meeting grant with the current main-frame context', () => {
    expect(permissionRequest(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'pending' }), 'media', audioRequest())).toBe(true)
    expect(permissionRequest(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'established' }), 'media', audioRequest())).toBe(false)
    const staleContext = fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'pending' })
    staleContext.setContext({ authSessionGeneration: 5, contextRevision: 9 })
    expect(permissionRequest(staleContext, 'media', audioRequest())).toBe(false)
    const childFrame = fixture({ lease: false, meeting: true, meetingGrant: true })
    childFrame.setFrame({ parent: {} as Electron.WebFrameMain, url: CURRENT_URL })
    expect(permissionRequest(childFrame, 'media', audioRequest())).toBe(false)
  })

  it('denies audio without an active lease, when hidden, or when auth is unavailable', () => {
    expect(permissionRequest(fixture({ lease: false }), 'media', audioRequest())).toBe(false)
    const hidden = fixture()
    hidden.setVisible(false)
    expect(permissionRequest(hidden, 'media', audioRequest())).toBe(false)
    const unauthenticated = fixture()
    unauthenticated.setAuthenticated(false)
    expect(permissionRequest(unauthenticated, 'media', audioRequest())).toBe(false)
  })

  it('denies new audio requests when OS lifecycle hooks are unavailable', () => {
    expect(permissionRequest(fixture({ lifecycleReady: false }), 'media', audioRequest())).toBe(false)
  })

  it('denies revoked, non-top-frame, wrong-URL, and wrong-origin requests', () => {
    const revoked = fixture()
    revoked.authority.hardStop('sign-out')
    expect(permissionRequest(revoked, 'media', audioRequest())).toBe(false)

    expect(permissionRequest(fixture(), 'media', audioRequest({ isMainFrame: false }))).toBe(false)
    expect(permissionRequest(fixture(), 'media', audioRequest({ requestingUrl: 'https://metis.example/other' }))).toBe(false)
    expect(permissionRequest(fixture(), 'media', audioRequest({ securityOrigin: 'https://other.example' }))).toBe(false)
    const childFrame = fixture()
    childFrame.setFrame({ parent: {} as Electron.WebFrameMain, url: CURRENT_URL })
    expect(permissionRequest(childFrame, 'media', audioRequest())).toBe(false)
    const staleMainFrameUrl = fixture()
    staleMainFrameUrl.setFrame({ parent: null, url: 'https://metis.example/old-document' })
    expect(permissionRequest(staleMainFrameUrl, 'media', audioRequest())).toBe(false)
    const staleContext = fixture()
    staleContext.setContext({ authSessionGeneration: 5, contextRevision: 9 })
    expect(permissionRequest(staleContext, 'media', audioRequest())).toBe(false)
    expect(permissionRequest(fixture(), 'media', {} as Electron.MediaAccessPermissionRequest)).toBe(false)
  })

  it('does not consume a meeting claim until frame, origin, and existing permission checks pass', () => {
    const child = fixture({ lease: false, meeting: true, meetingGrant: true })
    expect(permissionRequest(child, 'media', audioRequest({ isMainFrame: false }))).toBe(false)
    expect(child.meetingClaimCalls()).toBe(0)

    const crossOrigin = fixture({ lease: false, meeting: true, meetingGrant: true })
    expect(permissionRequest(crossOrigin, 'media', audioRequest({ securityOrigin: 'https://other.example' }))).toBe(false)
    expect(crossOrigin.meetingClaimCalls()).toBe(0)

    const deniedByExistingGate = fixture({ lease: false, meeting: true, meetingGrant: true, existingPermission: false })
    expect(permissionRequest(deniedByExistingGate, 'media', audioRequest())).toBe(false)
    expect(deniedByExistingGate.meetingClaimCalls()).toBe(0)
  })
})

describe('main microphone permission check gate', () => {
  const checkAudio = (
    env: ReturnType<typeof fixture>,
    details: Partial<Electron.PermissionCheckHandlerHandlerDetails> = {},
    requestingOrigin = CURRENT_ORIGIN
  ): boolean => env.check(env.webContents, 'media', requestingOrigin, {
    mediaType: 'audio',
    requestingUrl: CURRENT_URL,
    isMainFrame: true,
    ...details
  })

  it('denies a pending capture check until the request handler claims it, then preserves the video gate', () => {
    const env = fixture()
    expect(checkAudio(env)).toBe(false)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(true)
    expect(checkAudio(env)).toBe(true)
    expect(env.meetingClaimCalls()).toBe(0)
    expect(env.check(env.webContents, 'media', CURRENT_ORIGIN, { mediaType: 'video', isMainFrame: true })).toBe(true)
  })

  it('allows an accepted meeting check only with its exact renderer capture grant', () => {
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: true }))).toBe(false)
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'permission-authorized' }))).toBe(true)
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: false }))).toBe(false)
  })

  it('keeps permission checks read-only while a request atomically consumes one meeting claim', () => {
    const env = fixture({ lease: false, meeting: true, meetingGrant: true })
    expect(checkAudio(env)).toBe(false)
    expect(env.meetingClaimCalls()).toBe(0)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(true)
    expect(env.meetingClaimCalls()).toBe(1)
    // Electron's read-only permission-check may occur after the request hook consumes the claim.
    expect(checkAudio(env)).toBe(true)
    expect(permissionRequest(env, 'media', audioRequest())).toBe(false)
    expect(env.meetingClaimCalls()).toBe(1)
  })

  it('allows only permission-authorized meeting grants in read-only checks', () => {
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'pending' }))).toBe(false)
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'permission-authorized' }))).toBe(true)
    expect(checkAudio(fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'established' }))).toBe(false)
    const staleContext = fixture({ lease: false, meeting: true, meetingGrant: true, meetingGrantState: 'pending' })
    staleContext.setContext({ authSessionGeneration: 5, contextRevision: 9 })
    expect(checkAudio(staleContext)).toBe(false)
    const childFrame = fixture({ lease: false, meeting: true, meetingGrant: true })
    childFrame.setFrame({ parent: {} as Electron.WebFrameMain, url: CURRENT_URL })
    expect(checkAudio(childFrame)).toBe(false)
  })

  it('denies audio without an active lease, when hidden, or after revocation', () => {
    expect(checkAudio(fixture({ lease: false }))).toBe(false)
    const hidden = fixture()
    hidden.setVisible(false)
    expect(checkAudio(hidden)).toBe(false)
    const revoked = fixture()
    revoked.authority.hardStop('sign-out')
    expect(checkAudio(revoked)).toBe(false)
  })

  it('denies audio checks when OS lifecycle hooks are unavailable', () => {
    expect(checkAudio(fixture({ lifecycleReady: false }))).toBe(false)
  })

  it('denies subframe, stale-URL, and cross-origin checks', () => {
    expect(checkAudio(fixture(), { isMainFrame: false })).toBe(false)
    expect(checkAudio(fixture(), { requestingUrl: 'https://metis.example/other' })).toBe(false)
    expect(checkAudio(fixture(), {}, 'https://other.example')).toBe(false)
    const staleContext = fixture()
    staleContext.setContext({ authSessionGeneration: 5, contextRevision: 9 })
    expect(checkAudio(staleContext)).toBe(false)
    const unknown = fixture()
    expect(unknown.check(unknown.webContents, 'media', CURRENT_ORIGIN, { mediaType: 'unknown', isMainFrame: true })).toBe(false)
  })
})
