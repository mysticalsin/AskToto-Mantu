// Compatibility path for the dashboard slug module. The implementation lives in shared so renderer
// session identities and intelligence slugs use the same browser-safe, dependency-free digest.
export { sha256Hex } from '../../../src/shared/sha256'
