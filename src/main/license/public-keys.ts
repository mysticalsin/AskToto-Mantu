/**
 * Embedded Ed25519 public keys for offline JWS verify.
 * The matching private key never ships in the client.
 * Replace `metis-2026-1` at the minting ceremony before LICENSE_ACTIVATION_OPEN flips.
 */
import { LICENSE_KID } from '@shared/license-types'

export const LICENSE_PUBLIC_KEYS: Record<string, string> = {
  [LICENSE_KID]: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdzdZHrN2fkXci+G5L+VJRLH8lJxFS3pcTEy0nN5kqnA=
-----END PUBLIC KEY-----`
}
