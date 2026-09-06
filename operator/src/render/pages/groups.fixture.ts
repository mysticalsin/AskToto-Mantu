/**
 * Groups page fixture overlay (plan "if your page needs fixture data the shared fixture lacks").
 * operator/src/render/fixture.ts's fixtureDashboard() already seeds 3 real groups (Sales Paris,
 * Delivery Montreal, Leadership), 2 tiers and their members into a memory store through
 * fixtureRows()/seedStore() -- buildDashboard() just never surfaces them in DashboardPayload
 * (dashboard.ts, a shared file this page does not own; see groups.ts's top comment). This module
 * seeds the same deterministic rows into a fresh memory store, adds one adversarial group whose
 * name is a script tag (for the esc() security-carry-over test) and then calls the REAL
 * GET /v1/admin/groups[/:id] handlers through operator/src/index.ts's handleRequest() -- the same
 * way operator/src/routes/groups.test.ts drives them -- so every number and every nested shape
 * this page's tests see is computed by production code against real seeded rows, never
 * hand-typed. Worker-safe (operator/tsconfig.json, WebWorker lib, no Node/DOM builtins).
 */
import { handleRequest, type Env } from '../../index'
import { fixtureRows } from '../fixture'
import { memoryStore, type GroupMemberRow, type GroupRow } from '../../store'
import type { GroupDetailPayload, GroupListRow } from './groups'

const FIXTURE_EMAIL = 'tony.walteur@gmail.com'

/** The exact group name the P1.10 brief's security test renders and asserts appears as text. */
export const XSS_GROUP_NAME = '<script>x</script>'
export const XSS_GROUP_ID = 'xss-group-fixture'

/**
 * operator/src/test-fixtures.ts carries the same two values (TEST_INGEST_SECRET,
 * TEST_PROMPT_KEY) but is Node-flavoured (`Buffer.alloc(...)`) and only ever meant for `.test.ts`
 * files, which operator/tsconfig.json excludes from type-checking; importing it from this
 * non-test module would pull a `Buffer`-typed file into the Worker-lib compile and fail `tsc`
 * (no `@types/node` in this tsconfig, by design -- this file has no Node builtins). Reproduced
 * here with the Worker-safe primitives operator/src/render/fixture.ts already restricts itself
 * to: `Buffer.alloc(32, 7).toString('base64')` is exactly 32 bytes of 0x07, base64-encoded.
 */
const TEST_INGEST_SECRET = 'operator-ingest-secret-for-tests'
const TEST_PROMPT_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc='

function env(): Env {
  return { OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET, OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY, OPERATOR_SKILL_PRIVATE_KEY: '' }
}

const accessCtx = { access: { getIdentity: async () => ({ email: FIXTURE_EMAIL }) } }

async function get<T>(store: ReturnType<typeof memoryStore>, now: number, path: string): Promise<T> {
  const res = await handleRequest(
    new Request(`https://operator.test${path}`, { headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } }),
    env(),
    accessCtx,
    { store, now }
  )
  if (!res.ok) throw new Error(`groups.fixture: ${path} returned ${res.status}`)
  return (await res.json()) as T
}

export interface GroupsFixture {
  now: number
  /** GET /v1/admin/groups's real response, including the adversarial XSS_GROUP_ID row. */
  list: GroupListRow[]
  /** GET /v1/admin/groups/:id's real response for every group id in `list`, keyed by id. */
  detail: Record<string, GroupDetailPayload>
}

/**
 * Builds a fresh memory store from fixtureRows(now), adds one group named XSS_GROUP_NAME with an
 * HTML-bearing note and one email member whose local part also carries a script tag (member
 * strings are free text on the wire, only validated as "looks like an email or a known device
 * id" -- an attacker-chosen display name is exactly what esc() must survive), then reads the list
 * and every group's detail back through the real routes.
 */
export async function fixtureForGroups(now: number = 1_725_000_000_000): Promise<GroupsFixture> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  for (const seat of rows.seats) await store.upsertSeat(seat)
  for (const lic of rows.issuedLicenses) await store.putIssuedLicense(lic)
  for (const group of rows.groups) await store.putGroup(group)
  for (const member of rows.groupMembers) await store.putGroupMember(member)
  for (const tier of rows.tiers) await store.putTier(tier)

  const xssGroup: GroupRow = {
    id: XSS_GROUP_ID,
    name: XSS_GROUP_NAME,
    tier: 'metis-light',
    notes: '<img src=x onerror=alert(1)> also escape this',
    created_at: now - 3 * 24 * 60 * 60 * 1000,
    created_by: FIXTURE_EMAIL
  }
  await store.putGroup(xssGroup)
  const xssMember: GroupMemberRow = {
    group_id: XSS_GROUP_ID,
    member: '<b>bold</b>@example.com',
    kind: 'email',
    added_at: now - 2 * 24 * 60 * 60 * 1000,
    added_by: FIXTURE_EMAIL
  }
  await store.putGroupMember(xssMember)

  const listRes = await get<{ ok: true; groups: GroupListRow[] }>(store, now, '/v1/admin/groups')
  const detail: Record<string, GroupDetailPayload> = {}
  for (const g of listRes.groups) {
    const d = await get<{ ok: true } & GroupDetailPayload>(store, now, `/v1/admin/groups/${encodeURIComponent(g.id)}`)
    detail[g.id] = { group: d.group, members: d.members, licenses: d.licenses, seats: d.seats, activity: d.activity }
  }
  return { now, list: listRes.groups, detail }
}
