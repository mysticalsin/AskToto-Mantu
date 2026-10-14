/** Package contents are selected by the build, never by a user preference. */
export type PackageProfile = 'full' | 'lean'

export interface PackageInventoryCoreFile {
  path: string
  bytes: number
  sha256: string
}

export interface PackageInventoryV1 {
  schema: 1
  profile: PackageProfile
  platform: 'darwin' | 'win32'
  arch: 'arm64' | 'x64' | 'universal'
  appVersion: string
  electronVersion: string
  sourceCommit: string
  coreFiles: PackageInventoryCoreFile[]
  identity: string
}

declare const __METIS_PACKAGE_PROFILE__: PackageProfile

/** The profile compiled into both the main process and renderer for this package. */
export const METIS_PACKAGE_PROFILE: PackageProfile =
  typeof __METIS_PACKAGE_PROFILE__ === 'undefined' ? 'full' : __METIS_PACKAGE_PROFILE__
