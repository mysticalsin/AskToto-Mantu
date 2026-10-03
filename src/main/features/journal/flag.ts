import { devEnv } from '../../dev-env'

/**
 * The `journal` feature flag, off by default. Only a development build can turn it on, with
 * ASKTOTO_FLAG_JOURNAL=1; a packaged build ignores the variable (dev-env.ts), so a planted environment
 * variable can never start writing meeting content to the journal of a shipped install.
 */
export const JOURNAL_FLAG = 'journal'

export function journalEnabled(): boolean {
  return devEnv('ASKTOTO_FLAG_JOURNAL') === '1'
}
