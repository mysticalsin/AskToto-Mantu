/**
 * Where a seat's active licence came from (O05). Shared by the dashboard payload and the console render
 * so the label is defined once. Honesty rule: only a licence the Worker itself minted from a verified Entra
 * sign-in is "SSO", and only then is an e-mail shown, and it is the Worker-verified one
 * (`seats.sso_verified_email`), never the device-claimed `sso_email`. A seat enrolled with the embedded
 * token is labelled "Token · Unverified": the token proves a build, not a person. Everything else
 * (every seat that existed before enrolment shipped, manual or MDM licences, approvals) is "Admin".
 */
import type { IssuedLicenseRow, SeatRow } from '../store'

export type SourceKind = 'admin' | 'sso' | 'token'

export interface SourceInfo {
  kind: SourceKind
  /** Worker-verified e-mail; only ever set for `sso`. */
  email: string | null
}

export const SOURCE_KINDS: readonly SourceKind[] = ['admin', 'sso', 'token']

export function seatSource(seat: Pick<SeatRow, 'enroll_method' | 'sso_verified_email'>): SourceInfo {
  if (seat.enroll_method === 'sso') return { kind: 'sso', email: seat.sso_verified_email?.trim() || null }
  if (seat.enroll_method === 'token') return { kind: 'token', email: null }
  return { kind: 'admin', email: null }
}

export function licenseSource(row: Pick<IssuedLicenseRow, 'origin' | 'member'>): SourceInfo {
  if (row.origin === 'sso-enroll') return { kind: 'sso', email: row.member?.trim() || null }
  if (row.origin === 'token-enroll') return { kind: 'token', email: null }
  return { kind: 'admin', email: null }
}

export function sourceLabel(kind: SourceKind): string {
  return kind === 'sso' ? 'SSO' : kind === 'token' ? 'Token · Unverified' : 'Admin'
}
