export type CloudSttWindowOwner<Window, Contents> = Readonly<{
  window: Window
  webContents: Contents
  webContentsId: number
}>

/** Match a renderer by the immutable wrappers captured before close, never by a destroyed window getter. */
export function shouldInvalidateCloudSttOwner<Window, Contents>(
  currentWindow: Window | null,
  acceptedWebContents: Contents | null | undefined,
  owner?: CloudSttWindowOwner<Window, Contents>
): boolean {
  return owner === undefined || currentWindow === owner.window || acceptedWebContents === owner.webContents
}

/** A stale window may revoke only the cloud owner carrying its captured ID. */
export function shouldClearCloudSttIpcOwner<Window, Contents>(
  currentOwnerWebContentsId: number | undefined,
  owner?: CloudSttWindowOwner<Window, Contents>
): boolean {
  return owner === undefined || currentOwnerWebContentsId === owner.webContentsId
}

/** A destroyed BrowserWindow must be rejected before accessing its potentially throwing webContents getter. */
export function isCurrentCloudSttSender<
  Contents extends { id: number; isDestroyed(): boolean },
  Window extends { isDestroyed(): boolean; webContents: Contents }
>(currentWindow: Window | null, ownerWebContentsId: number, sender: Contents): boolean {
  return (
    currentWindow !== null &&
    !currentWindow.isDestroyed() &&
    currentWindow.webContents === sender &&
    !sender.isDestroyed() &&
    ownerWebContentsId === sender.id
  )
}
