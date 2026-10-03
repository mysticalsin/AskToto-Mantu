import type { PermissionStatus } from '@shared/ipc'

export interface ScreenCaptureGrantGateDeps {
  platform: NodeJS.Platform | string
  macScreenStatus: () => PermissionStatus
  windowsScreenStatus: () => PermissionStatus
}

export function createScreenCaptureGrantGate({
  platform,
  macScreenStatus,
  windowsScreenStatus
}: ScreenCaptureGrantGateDeps): (() => boolean) | undefined {
  if (platform === 'darwin') return () => macScreenStatus() === 'granted'
  if (platform === 'win32') return () => windowsScreenStatus() === 'granted'
  return undefined
}
