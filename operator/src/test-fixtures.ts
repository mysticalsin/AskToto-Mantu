/**
 * Non-key test constants. Skill-pack keypairs are generated at runtime
 * (generateKeyPairSync) so this repo never contains a PEM block.
 */
export const TEST_INGEST_SECRET = 'operator-ingest-secret-for-tests'
export const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString('base64')
export const TEST_VAULT_KEY = Buffer.alloc(32, 11).toString('base64')
/** Designed team domain. Not a secret. Access is not enabled on the account yet. */
export const TEST_TEAM_DOMAIN = 'https://tony-walteur.cloudflareaccess.com'
