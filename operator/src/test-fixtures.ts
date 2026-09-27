/**
 * Non-key test constants. Skill-pack keypairs are generated at runtime
 * (generateKeyPairSync) so this repo never contains a PEM block.
 */
export const TEST_INGEST_SECRET = 'operator-ingest-secret-for-tests'
export const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString('base64')
export const TEST_VAULT_KEY = Buffer.alloc(32, 11).toString('base64')
export const TEST_OWNER_EMAIL = 'owner@example.test'
export const TEST_ADMIN_EMAIL = 'admin@example.test'
export const TEST_ADMIN_EMAILS = `${TEST_OWNER_EMAIL},${TEST_ADMIN_EMAIL}`
export const TEST_CLOUDFLARE_ACCOUNT_ID = '00000000000000000000000000000000'
/** Designed team domain. Not a secret. Access is not enabled on the account yet. */
export const TEST_TEAM_DOMAIN = 'https://metis-test.cloudflareaccess.com'

export function syntheticProviderKey(provider: 'anthropic' | 'cloudflare' | 'openai', tail = 'xx99'): string {
  const prefix = provider === 'anthropic' ? ['sk', 'ant', 'api03'] : provider === 'cloudflare' ? ['sk', 'cf'] : ['sk']
  const body = provider === 'openai' ? ['OPENAI', 'OPERATOR', 'VAULT', 'TEST', 'only'] : ['OPERATOR', 'VAULT', 'TEST', 'only']
  return [...prefix, ...body, tail].join('-')
}

export function syntheticSecretLikeText(tail = 'abcdefghijklmnopqrstuvwxyz'): string {
  return ['sk', 'ant', 'api03', tail].join('-')
}
