/**
 * Whether native helpers may be spawned. Separate from helper-reverify so mac-helper.ts can read it without an
 * import cycle (reverify needs mac-helper's code-identity reader). `pending` holds helpers back from the moment
 * a just-installed update is detected until re-verification finishes.
 */
export type HelperTrust = 'trusted' | 'pending' | 'quarantined'

let trust: HelperTrust = 'trusted'

export function setHelperTrust(next: HelperTrust): void {
  trust = next
}

export function isHelperQuarantined(): boolean {
  return trust !== 'trusted'
}
