import { InputSessionAuthority } from './input-session-authority'
import type { TrustedInputOwner } from '@shared/input-session'

type PermissionRequestHandler = NonNullable<Parameters<Electron.Session['setPermissionRequestHandler']>[0]>
type PermissionCheckHandler = NonNullable<Parameters<Electron.Session['setPermissionCheckHandler']>[0]>

interface InputMicPermissionDependencies {
  session: Pick<Electron.Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>
  getWindow: () => Electron.BrowserWindow | null
  isAuthenticated: () => boolean
  isCaptureLifecycleReady: () => boolean
  currentContext: () => Pick<TrustedInputOwner, 'authSessionGeneration' | 'contextRevision'>
  authority: InputSessionAuthority
  hasMeetingCaptureRequestOwner: (
    webContentsId: number,
    startedAt: number | null,
    context: Pick<TrustedInputOwner, 'authSessionGeneration' | 'contextRevision'>,
    requestingUrl: string
  ) => boolean
  hasMeetingCaptureCheckOwner: (
    webContentsId: number,
    startedAt: number | null,
    context: Pick<TrustedInputOwner, 'authSessionGeneration' | 'contextRevision'>,
    requestingUrl: string
  ) => boolean
  claimMeetingCapturePermission: (frame: { webContentsId: number; isTopFrame: boolean; url: string }) => boolean
  claimInteractiveCapturePermission: (owner: TrustedInputOwner) => boolean
  allowExistingPermission: (webContents: Electron.WebContents | null, permission: string) => boolean
}

/** Install the microphone owner gate while retaining the established video/clipboard permission paths. */
export function installInputMicPermissionHandlers(deps: InputMicPermissionDependencies): {
  requestHandler: PermissionRequestHandler
  checkHandler: PermissionCheckHandler
} {
  const microphoneAccess = (
    webContents: Electron.WebContents | null,
    requestingUrl: string | undefined,
    isMainFrame: boolean | undefined,
    requestAdmission = false
  ): { allowed: boolean; interactive: boolean } => {
    const win = deps.getWindow()
    if (
      !deps.isCaptureLifecycleReady() ||
      !webContents ||
      !win ||
      win.isDestroyed() ||
      webContents !== win.webContents ||
      !isMainFrame ||
      !win.isVisible()
    ) {
      return { allowed: false, interactive: false }
    }
    const currentUrl = webContents.getURL()
    if (!currentUrl || requestingUrl !== currentUrl || !deps.isAuthenticated())
      return { allowed: false, interactive: false }
    const mainFrame = webContents.mainFrame
    if (!mainFrame || mainFrame.parent !== null || mainFrame.url !== currentUrl)
      return { allowed: false, interactive: false }
    const context = deps.currentContext()
    deps.authority.reconcileContext(context)
    const frameId = `${mainFrame.processId}:${mainFrame.routingId}`
    const owner = {
      webContentsId: webContents.id,
      frameId,
      isTopFrame: true,
      authSessionGeneration: context.authSessionGeneration,
      contextRevision: context.contextRevision
    }
    const interactiveOwner = requestAdmission
      ? deps.authority.hasPermissionRequestOwner(owner)
      : deps.authority.hasPermissionCheckOwner(owner)
    const meetingCaptureOwner =
      deps.authority.hasMeetingReservation &&
      (requestAdmission
        ? deps.hasMeetingCaptureRequestOwner(webContents.id, deps.authority.meetingStartedAt, context, currentUrl)
        : deps.hasMeetingCaptureCheckOwner(webContents.id, deps.authority.meetingStartedAt, context, currentUrl))
    return { allowed: interactiveOwner || meetingCaptureOwner, interactive: interactiveOwner }
  }

  const requestHandler: PermissionRequestHandler = (webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(deps.allowExistingPermission(webContents, permission))
      return
    }
    // Electron passes a union here. Only its MediaAccessPermissionRequest member has the required
    // mediaTypes/securityOrigin proof; absent or unknown shapes cannot authorize microphone access.
    const mediaDetails: Electron.MediaAccessPermissionRequest | null =
      details && typeof details === 'object' && 'mediaTypes' in details
        ? (details as Electron.MediaAccessPermissionRequest)
        : null
    const mediaTypes = mediaDetails?.mediaTypes
    const audioRequested = Array.isArray(mediaTypes) && mediaTypes.includes('audio')
    const knownMediaTypes = Array.isArray(mediaTypes) && mediaTypes.length > 0
    let originMatches = false
    try {
      const currentUrl = webContents?.getURL()
      originMatches =
        !!mediaDetails?.securityOrigin &&
        !!currentUrl &&
        new URL(mediaDetails.securityOrigin).origin === new URL(currentUrl).origin
    } catch {
      /* deny below */
    }
    const currentUrl = webContents?.getURL()
    const mainFrame = webContents?.mainFrame
    const currentTopFrame = !!currentUrl && !!mainFrame && mainFrame.parent === null && mainFrame.url === currentUrl
    const access =
      audioRequested && mediaDetails
        ? microphoneAccess(webContents, mediaDetails.requestingUrl, mediaDetails.isMainFrame, true)
        : { allowed: true, interactive: false }
    const permissionAllowed =
      knownMediaTypes &&
      (!audioRequested ||
        (mediaDetails !== null &&
          mediaDetails.isMainFrame === true &&
          mediaDetails.requestingUrl === currentUrl &&
          originMatches &&
          currentTopFrame &&
          access.allowed)) &&
      deps.allowExistingPermission(webContents, permission)
    const captureClaimed =
      !audioRequested ||
      !permissionAllowed ||
      (access.interactive
        ? deps.claimInteractiveCapturePermission({
            webContentsId: webContents?.id ?? -1,
            frameId: mainFrame ? `${mainFrame.processId}:${mainFrame.routingId}` : '',
            isTopFrame: mediaDetails?.isMainFrame === true,
            authSessionGeneration: deps.currentContext().authSessionGeneration,
            contextRevision: deps.currentContext().contextRevision
          })
        : deps.claimMeetingCapturePermission({
            webContentsId: webContents?.id ?? -1,
            isTopFrame: mediaDetails?.isMainFrame === true,
            url: mediaDetails?.requestingUrl ?? ''
          }))
    callback(permissionAllowed && captureClaimed)
  }

  const checkHandler: PermissionCheckHandler = (webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media') return deps.allowExistingPermission(webContents, permission)
    if (details?.mediaType === 'audio') {
      const requestingUrl = details.requestingUrl
      const currentUrl = webContents?.getURL()
      let sameOrigin = false
      try {
        sameOrigin =
          !!requestingOrigin && !!currentUrl && new URL(requestingOrigin).origin === new URL(currentUrl).origin
      } catch {
        /* deny below */
      }
      return sameOrigin && microphoneAccess(webContents, requestingUrl, details.isMainFrame).allowed
    }
    if (details?.mediaType === 'video') return deps.allowExistingPermission(webContents, permission)
    return false
  }

  deps.session.setPermissionRequestHandler(requestHandler)
  deps.session.setPermissionCheckHandler(checkHandler)
  return { requestHandler, checkHandler }
}
