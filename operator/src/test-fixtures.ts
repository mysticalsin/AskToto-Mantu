/**
 * Non-key test constants. Skill-pack keypairs are generated at runtime
 * (generateKeyPairSync) so this repo never contains a PEM block.
 */
export const TEST_INGEST_SECRET = 'operator-ingest-secret-for-tests'
export const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString('base64')
export const TEST_VAULT_KEY = Buffer.alloc(32, 11).toString('base64')
/** Test-only Worker admin password. Not a production secret. */
export const TEST_ADMIN_PASSWORD = 'operator-admin-password-for-tests'
