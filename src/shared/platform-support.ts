/**
 * platform-support.ts — the one typed source of truth for the minimum operating system Métis runs on (D-26).
 *
 * macOS 14.4: system-audio capture uses Core Audio process taps, which need 14.4 (owner decision D-26).
 * electron-builder's `mac.minimumSystemVersion` must equal MIN_MACOS.label (pinned by
 * scripts/platform-support.contract.test.ts); the runtime gate in main/lifecycle/startup-gate.ts reads the same constant.
 * Windows: Electron 43 (Chromium) no longer runs below Windows 10; build 17763 is Windows 10 version 1809.
 * ASSUMED: the 1809 floor is the conservative Windows 10 baseline for this Electron line, not checked against a
 * Windows 10 1607/1703/1709/1803 machine. Raise it here if installed QA proves a higher floor.
 */
export const MIN_MACOS = { major: 14, minor: 4, label: '14.4' } as const
export const MIN_WINDOWS = { major: 10, build: 17763, label: '10 version 1809' } as const

export type PlatformSupport = { supported: true } | { supported: false; message: string }

export function unsupportedOsCopy(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `Métis needs Windows ${MIN_WINDOWS.label} or later.`
    : `Métis needs macOS ${MIN_MACOS.label} or later.`
}

/** `version` is Electron's `process.getSystemVersion()` ("14.4.1", "10.0.19045"). An unreadable version fails
 *  open: refusing to start on a guess would lock a supported person out. */
export function evaluatePlatformSupport(platform: NodeJS.Platform, version: string | undefined): PlatformSupport {
  const parts = (version ?? '').split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return { supported: true }
  const [major = 0, second = 0, third = 0] = parts
  let supported = true
  if (platform === 'darwin')
    supported = major > MIN_MACOS.major || (major === MIN_MACOS.major && second >= MIN_MACOS.minor)
  else if (platform === 'win32')
    supported = major > MIN_WINDOWS.major || (major === MIN_WINDOWS.major && third >= MIN_WINDOWS.build)
  return supported ? { supported } : { supported, message: unsupportedOsCopy(platform) }
}
