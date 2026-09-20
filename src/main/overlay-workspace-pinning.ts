export type WorkspacePinnedWindow = {
  setVisibleOnAllWorkspaces: (visible: boolean, options: { visibleOnFullScreen: boolean }) => void
}

const workspacePinnedWindows = new WeakSet<object>()

/** Electron may briefly hide a macOS window while changing its process type, so do this once per window. */
export function pinWindowOnAllWorkspaces(
  overlay: WorkspacePinnedWindow,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32' || workspacePinnedWindows.has(overlay)) return
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  workspacePinnedWindows.add(overlay)
}
