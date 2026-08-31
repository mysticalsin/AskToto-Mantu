/**
 * Test-only secrets. Never used in production. Matching public key is
 * src/main/operator-skill-key.ts DEV_OPERATOR_PUBLIC_KEY.
 */
export const TEST_INGEST_SECRET = 'operator-ingest-secret-for-tests'
export const TEST_PROMPT_KEY = Buffer.alloc(32, 7).toString('base64')
export const TEST_SKILL_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIEOwETKCstJy6hFM8DzRSTeuulKEydvv0NRU5dZVuEVw
-----END PRIVATE KEY-----
`
export const TEST_SKILL_PUBLIC_KEY = 'ahLO-YDwg2Z9RipORWu0kdUO4Ehw81FdwwUsfbN7DqI'
