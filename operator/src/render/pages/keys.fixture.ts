/**
 * Keys page fixture overlay (plan "if your page needs fixture data the shared fixture lacks").
 * operator/src/render/fixture.ts's fixtureDashboard() never seeds any `vault_keys` row and always
 * passes buildDashboard() its default (all-missing) key flags and Cloudflare overview -- correct
 * for the shared fixture (an empty vault is a real, honest state every page must render), but it
 * means Keys' own tests would only ever see the empty state.
 *
 * This overlay starts from the exact same building blocks fixtureDashboard() uses --
 * `fixtureRows()` and `seedStore()`, both exported by operator/src/render/fixture.ts -- adds a
 * small, deterministic set of vault_keys rows and two `kind: 'use'` events through the real store
 * methods (never a hand-assembled DashboardPayload), then calls the real `buildDashboard()` once
 * with a populated `keys` flag set and a `connected: true` CloudflareOverview. Every number Keys
 * renders from this fixture (asks 7d, tokens 7d, cost estimate) is still derived by production
 * code from the shared fixture's real 7-day ask rows for anthropic/openai/cloudflare
 * (fixture.ts's `PROVIDER_WEIGHTS`) -- only the vault rows, the two use-events and the Cloudflare
 * account numbers are hand-authored here, because nothing in this repo derives any of those three
 * from stored rows (a vault row is exactly what `POST /v1/admin/keys` would have written; a
 * Cloudflare account's own request/error/cpu counters come from Cloudflare's REST API, which a
 * fixture cannot call).
 *
 * Worker-safe (operator/tsconfig.json, WebWorker lib): only `memoryStore()` and `buildDashboard()`.
 */
import { buildDashboard, type DashboardPayload } from '../../dashboard'
import { OPERATOR_D1_ID, OPERATOR_D1_NAME, OPERATOR_WORKER } from '../../vault'
import { memoryStore, type EventRow, type VaultKeyRow } from '../../store'
import { fixtureRows, seedStore, FIXTURE_EMAIL, FIXTURE_NOW } from '../fixture'
import type { CloudflareOverview } from '../../cloudflare'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

/** Deterministic, clearly-fake last4/cipher placeholders -- never real secret material, same
 *  convention fixture.ts's own `placeholderCipher()` documents for asks' prompt ciphertext. */
function vaultSeeds(now: number): VaultKeyRow[] {
  return [
    {
      id: 'fx-vault-anthropic',
      provider: 'anthropic',
      label: 'Anthropic production',
      last4: 'k9f2',
      cipher: 'fx-cipher',
      iv: 'fx-iv',
      status: 'active',
      created_at: now - 60 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: now - 10 * DAY,
      revoked_at: null
    },
    {
      id: 'fx-vault-anthropic-old',
      provider: 'anthropic',
      label: 'Anthropic production',
      last4: 'a1b2',
      cipher: '',
      iv: '',
      status: 'superseded',
      created_at: now - 120 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: now - 60 * DAY,
      revoked_at: null
    },
    {
      id: 'fx-vault-openai',
      provider: 'openai',
      label: 'OpenAI fallback',
      last4: 'q7z1',
      cipher: 'fx-cipher',
      iv: 'fx-iv',
      status: 'active',
      created_at: now - 40 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: null,
      revoked_at: null
    },
    {
      id: 'fx-vault-cloudflare',
      provider: 'cloudflare',
      label: 'Workers AI gateway',
      last4: 'm4t8',
      cipher: 'fx-cipher',
      iv: 'fx-iv',
      status: 'active',
      created_at: now - 20 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: null,
      revoked_at: null
    },
    {
      id: 'fx-vault-custom',
      provider: 'custom',
      label: 'Internal proxy',
      last4: 'c2x9',
      cipher: 'fx-cipher',
      iv: 'fx-iv',
      status: 'active',
      created_at: now - 5 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: null,
      revoked_at: null
    },
    {
      id: 'fx-vault-groq',
      provider: 'groq',
      label: 'Groq trial',
      last4: 'g0k3',
      cipher: '',
      iv: '',
      status: 'revoked',
      created_at: now - 90 * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: null,
      revoked_at: now - 70 * DAY
    }
  ]
}

/** Two Operator-brokered calls (operator/src/use.ts's handleUse() shape: `kind: 'use'`, `detail:
 *  "use <provider>"`), from two of the shared fixture's real seats, so the Vault table's "last
 *  seat" column has a real match to show for anthropic and openai while cloudflare and custom
 *  honestly read "not reported" (no such event seeded for them). */
function useEvents(now: number): EventRow[] {
  return [
    {
      id: 'fx-use-anthropic',
      ts: now - 3 * HOUR,
      kind: 'use',
      actor: 'seat-ca-01',
      device_id: 'seat-ca-01',
      country: 'CA',
      detail: 'use anthropic'
    },
    {
      id: 'fx-use-openai',
      ts: now - 30 * HOUR,
      kind: 'use',
      actor: 'seat-fr-01',
      device_id: 'seat-fr-01',
      country: 'FR',
      detail: 'use openai'
    }
  ]
}

function cloudflareOverviewFixture(): CloudflareOverview {
  return {
    worker: OPERATOR_WORKER,
    connected: true,
    error: null,
    requests: 48213,
    errors: 12,
    cpuMs: 3540,
    range: '24h',
    workers: [OPERATOR_WORKER],
    d1Name: OPERATOR_D1_NAME,
    d1Id: OPERATOR_D1_ID
  }
}

/** The richer Keys payload: every flag bound, Cloudflare connected, a mixed vault (active,
 *  superseded, revoked, one unfunded-by-recent-asks provider) so a single screenshot exercises
 *  every state this page renders. */
export async function fixtureForKeys(now: number = FIXTURE_NOW): Promise<DashboardPayload> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)
  for (const v of vaultSeeds(now)) await store.putVaultKey(v)
  for (const e of useEvents(now)) await store.insertEvent(e)
  return buildDashboard(
    store,
    FIXTURE_EMAIL,
    now,
    { ingestBound: true, promptBound: true, skillBound: true, vaultBound: true, oauthBound: true },
    cloudflareOverviewFixture()
  )
}

/** Same vault/events, but the OAuth client is not configured on this Worker -- the Cloudflare
 *  card's disabled-connect-button state (plan 6.9: "connect button disabled with the reason when
 *  OAuth secrets are missing"). */
export async function fixtureForKeysNoOauth(now: number = FIXTURE_NOW): Promise<DashboardPayload> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)
  for (const v of vaultSeeds(now)) await store.putVaultKey(v)
  for (const e of useEvents(now)) await store.insertEvent(e)
  return buildDashboard(store, FIXTURE_EMAIL, now, {
    ingestBound: true,
    promptBound: true,
    skillBound: true,
    vaultBound: true,
    oauthBound: false
  })
}
