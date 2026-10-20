import { z } from 'zod'

export const PRIVACY_CLASSES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const

export const PrivacyClassSchema = z.enum(PRIVACY_CLASSES)
export type PrivacyClass = z.infer<typeof PrivacyClassSchema>

export const PRIVACY_CLASS_RULES: Readonly<Record<PrivacyClass, { readonly contents: string; readonly rule: string }>> =
  Object.freeze({
    P0: Object.freeze({ contents: 'App metadata', rule: 'Unrestricted' }),
    P1: Object.freeze({ contents: 'Operational counts and timings', rule: 'No content' }),
    P2: Object.freeze({
      contents: 'Owner content: transcripts, brain, recall index vectors, saved captures',
      rule: 'Stays local unless a per-action, user-initiated consent sends it through a routed provider'
    }),
    P3: Object.freeze({
      contents:
        'Restricted content: confidential meetings, anything captured or derived while Private View is on, secure fields, team-root sources',
      rule: 'Never leaves the device; never indexed by default'
    }),
    P4: Object.freeze({
      contents: 'Secrets: provider keys, license material',
      rule: 'Never in renderer, logs or model payloads'
    })
  })

/** P0 and P1 are unrestricted, P2 needs per-action consent, P3 and P4 never leave the device. */
export function mayLeaveDevice(cls: PrivacyClass, opts: { readonly userConsented: boolean }): boolean {
  switch (cls) {
    case 'P0':
    case 'P1':
      return true
    case 'P2':
      return opts.userConsented === true
    case 'P3':
    case 'P4':
      return false
    default: {
      const unreachable: never = cls
      return unreachable
    }
  }
}

/** Only content-free classes may be written to logs. */
export function mayLog(cls: PrivacyClass): boolean {
  return cls === 'P0' || cls === 'P1'
}
