/** Data-only catalog views. No native identity, target, or execution authority. */
export type ApplicationKind = 'notes' | 'browser' | 'document-editor' | 'terminal' |
  'system-admin' | 'installer' | 'credential-security' | 'camera-media-capture' | 'unknown'

export interface ApplicationView {
  readonly id: string
  readonly displayName: string
  readonly aliases: readonly string[]
  readonly kind: ApplicationKind
  readonly risk: 'R1' | 'restricted'
  readonly availability: 'available' | 'unavailable' | 'restricted'
}

export interface CandidateSetVersion {
  readonly revision: number
  readonly digest: string
}

export interface ApplicationCatalogSnapshot extends CandidateSetVersion {
  readonly applications: readonly ApplicationView[]
}

export type ApplicationResolution = CandidateSetVersion & (
  { readonly status: 'missing' } |
  { readonly status: 'ambiguous'; readonly candidates: readonly ApplicationView[] } |
  { readonly status: 'resolved' | 'unavailable'; readonly application: ApplicationView }
)

export type ApplicationRevalidation = CandidateSetVersion & (
  { readonly status: 'missing' } |
  { readonly status: 'valid' | 'stale' | 'unavailable'; readonly application: ApplicationView }
)
