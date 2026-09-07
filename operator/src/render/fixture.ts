/**
 * QA fixture (plan `metis-portal-wow.md`, section 6 and P5): one deterministic, dated dataset that
 * every section, preview and screenshot uses instead of hand-typed sample HTML.
 *
 * Contract:
 *  - Deterministic. `now` defaults to 2026-09-06T14:00:00Z. All pseudo-random spread (ask/heartbeat
 *    volume, token counts, latency, ratings) comes from a seeded PRNG (mulberry32), never
 *    `Math.random()` or `Date.now()`, so two runs produce byte-identical rows.
 *  - No plaintext prompts. `prompt_cipher` / `prompt_iv` are placeholder base64 blobs the store
 *    accepts as opaque strings; they are never a real AES-GCM ciphertext of real text.
 *  - No real people. Every name is invented, every email is `@example.com`.
 *  - No hand-typed KPI values. `fixtureDashboard()` runs the real `buildDashboard` against a
 *    `memoryStore()` seeded with these rows, so every number on a preview page is derived exactly
 *    the way production derives it.
 *  - No em dashes in any string this file writes.
 *
 * This file is Worker-safe (operator/tsconfig.json, WebWorker lib, no Node builtins): only
 * `btoa`/`TextEncoder`, matching the rest of operator/src.
 */
import { buildDashboard, ONLINE_MS, type DashboardPayload } from '../dashboard'
import { getConnectorCatalogEntry } from '../connectors/catalog'
import { applyPulse, type PulseKind, type SessionRow as SessionState } from '../sessions'
import {
  memoryStore,
  type AskRow,
  type AuditRow,
  type EventRow,
  type GroupMemberRow,
  type GroupRow,
  type IntegrationGrantRow,
  type IntegrationRow,
  type IssuedLicenseRow,
  type OperatorStore,
  type ProposalRow,
  type PulseRow,
  type SeatRow,
  type TierRow
} from '../store'
import { type CrmSendRow } from '../crm'
import { QUESTION_TYPES, QUESTION_TYPE_LABELS, type QuestionType } from '../../../src/shared/question-type'

export const FIXTURE_EMAIL = 'tony.walteur@gmail.com'
export const FIXTURE_NOW = Date.UTC(2026, 8, 6, 14, 0, 0)

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** mulberry32: tiny, fast, deterministic. Same seed, same sequence, every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function rng(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]
}

function intBetween(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function chance(rng: () => number, p: number): boolean {
  return rng() < p
}

function weightedPick<T>(rng: () => number, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let x = rng() * total
  for (const [item, weight] of entries) {
    if (x < weight) return item
    x -= weight
  }
  return entries[entries.length - 1][0]
}

function bytesToB64(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Opaque placeholder ciphertext. Never real AES-GCM output, never real text: just bytes the store
 *  will happily persist and never has to decrypt for a preview or a screenshot. */
function placeholderCipher(rng: () => number, len: number): string {
  return bytesToB64(Array.from({ length: len }, () => Math.floor(rng() * 256)))
}

// ---------------------------------------------------------------------------
// Seats: 12 seats, 6 countries, mixed OS, mixed license and approval states.
// ---------------------------------------------------------------------------

type SeatSeed = {
  deviceId: string
  country: string
  city: string
  region: string
  lat: number
  lon: number
  firstName: string
  lastName: string
  os: 'darwin' | 'win32'
  appVersion: string
  license: string
  approval: 'pending' | 'approved' | 'revoked'
  lastSeenOffsetMs: number
  firstSeenOffsetMs: number
  /** True for the seats that get keys authorized through an activated Operator license
   *  rather than a manual approval (plan lock 6: revoke always wins, approve is one path). */
  licensedViaIssuedLicense: boolean
}

const SEAT_SEEDS: SeatSeed[] = [
  {
    deviceId: 'seat-ca-01',
    country: 'CA',
    city: 'Montreal',
    region: 'Quebec',
    lat: 45.5017,
    lon: -73.5673,
    firstName: 'Lea',
    lastName: 'Martin',
    os: 'darwin',
    appVersion: '1.8.5',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 30 * 1000,
    firstSeenOffsetMs: 40 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-ca-02',
    country: 'CA',
    city: 'Toronto',
    region: 'Ontario',
    lat: 43.6532,
    lon: -79.3832,
    firstName: 'Marc',
    lastName: 'Tremblay',
    os: 'win32',
    appVersion: '1.8.4',
    license: 'trial',
    approval: 'pending',
    lastSeenOffsetMs: 3 * HOUR,
    firstSeenOffsetMs: 42 * DAY,
    licensedViaIssuedLicense: true
  },
  {
    deviceId: 'seat-fr-01',
    country: 'FR',
    city: 'Paris',
    region: 'Ile-de-France',
    lat: 48.8566,
    lon: 2.3522,
    firstName: 'Camille',
    lastName: 'Dubois',
    os: 'darwin',
    appVersion: '1.8.5',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 45 * 1000,
    firstSeenOffsetMs: 44 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-fr-02',
    country: 'FR',
    city: 'Lyon',
    region: 'Auvergne-Rhone-Alpes',
    lat: 45.764,
    lon: 4.8357,
    firstName: 'Hugo',
    lastName: 'Bernard',
    os: 'win32',
    appVersion: '1.8.3',
    license: 'unlicensed',
    approval: 'pending',
    lastSeenOffsetMs: 1 * DAY,
    firstSeenOffsetMs: 46 * DAY,
    licensedViaIssuedLicense: true
  },
  {
    deviceId: 'seat-de-01',
    country: 'DE',
    city: 'Berlin',
    region: 'Berlin',
    lat: 52.52,
    lon: 13.405,
    firstName: 'Mia',
    lastName: 'Fischer',
    os: 'darwin',
    appVersion: '1.8.4',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 90 * 1000,
    firstSeenOffsetMs: 48 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-de-02',
    country: 'DE',
    city: 'Munich',
    region: 'Bavaria',
    lat: 48.1351,
    lon: 11.582,
    firstName: 'Jonas',
    lastName: 'Weber',
    os: 'win32',
    appVersion: '1.8.5',
    license: 'trial',
    approval: 'pending',
    lastSeenOffsetMs: 6 * HOUR,
    firstSeenOffsetMs: 50 * DAY,
    licensedViaIssuedLicense: true
  },
  {
    deviceId: 'seat-us-01',
    country: 'US',
    city: 'Austin',
    region: 'Texas',
    lat: 30.2672,
    lon: -97.7431,
    firstName: 'Ava',
    lastName: 'Johnson',
    os: 'darwin',
    appVersion: '1.8.5',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 15 * 1000,
    firstSeenOffsetMs: 52 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-us-02',
    country: 'US',
    city: 'Seattle',
    region: 'Washington',
    lat: 47.6062,
    lon: -122.3321,
    firstName: 'Ethan',
    lastName: 'Brown',
    os: 'win32',
    appVersion: '1.8.3',
    license: 'unlicensed',
    approval: 'revoked',
    lastSeenOffsetMs: 2 * DAY,
    firstSeenOffsetMs: 54 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-br-01',
    country: 'BR',
    city: 'Sao Paulo',
    region: 'Sao Paulo',
    lat: -23.5505,
    lon: -46.6333,
    firstName: 'Sofia',
    lastName: 'Oliveira',
    os: 'darwin',
    appVersion: '1.8.4',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 4 * HOUR,
    firstSeenOffsetMs: 56 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-br-02',
    country: 'BR',
    city: 'Rio de Janeiro',
    region: 'Rio de Janeiro',
    lat: -22.9068,
    lon: -43.1729,
    firstName: 'Lucas',
    lastName: 'Souza',
    os: 'win32',
    appVersion: '1.8.5',
    license: 'trial',
    approval: 'pending',
    lastSeenOffsetMs: 12 * HOUR,
    firstSeenOffsetMs: 58 * DAY,
    licensedViaIssuedLicense: true
  },
  {
    deviceId: 'seat-in-01',
    country: 'IN',
    city: 'Bangalore',
    region: 'Karnataka',
    lat: 12.9716,
    lon: 77.5946,
    firstName: 'Ananya',
    lastName: 'Sharma',
    os: 'darwin',
    appVersion: '1.8.3',
    license: 'licensed',
    approval: 'approved',
    lastSeenOffsetMs: 5 * HOUR,
    firstSeenOffsetMs: 60 * DAY,
    licensedViaIssuedLicense: false
  },
  {
    deviceId: 'seat-in-02',
    country: 'IN',
    city: 'Mumbai',
    region: 'Maharashtra',
    lat: 19.076,
    lon: 72.8777,
    firstName: 'Rohan',
    lastName: 'Gupta',
    os: 'win32',
    appVersion: '1.8.4',
    license: 'unlicensed',
    approval: 'pending',
    lastSeenOffsetMs: 8 * HOUR,
    firstSeenOffsetMs: 62 * DAY,
    licensedViaIssuedLicense: true
  }
]

function seatHostname(seed: SeatSeed): string {
  const prefix = seed.os === 'darwin' ? 'mbp' : 'win'
  return `${prefix}-${seed.firstName.toLowerCase()}-${seed.lastName.toLowerCase()}`
}

function seatEmail(seed: SeatSeed): string {
  return `${seed.firstName.toLowerCase()}.${seed.lastName.toLowerCase()}@example.com`
}

function fnvHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Issued licenses: 8 total (2 revoked, 1 expiring in 5 days, 5 active + activated).
// ---------------------------------------------------------------------------

/** Fixed 16-hex jtis (operator-license.ts `parseLicenseId` requires exactly this shape). Hand
 *  written, not generated, so the fixture stays readable and stable across edits. */
const LICENSE_JTIS = [
  '0a1b2c3d4e5f6071',
  '1a2b3c4d5e6f7081',
  '2a3b4c5d6e7f8091',
  '3a4b5c6d7e8f90a1',
  '4a5b6c7d8e9f01b2',
  '5a6b7c8d9e0f12c3',
  '6a7b8c9d0e1f23d4',
  '7a8b9c0d1e2f34e5'
] as const

const GROUP_SALES_PARIS = 'group-sales-paris'
const GROUP_DELIVERY_MONTREAL = 'group-delivery-montreal'
const GROUP_LEADERSHIP = 'group-leadership'

function buildIssuedLicenses(now: number, seats: SeatRow[]): IssuedLicenseRow[] {
  const byDevice = new Map(seats.map((s) => [s.device_id, s]))
  const emailOf = (deviceId: string): string => byDevice.get(deviceId)?.sso_email ?? 'unknown@example.com'
  const rows: IssuedLicenseRow[] = []

  // L0, L1: revoked. One was activated once, one never claimed.
  const l0CreatedAt = now - 90 * DAY
  rows.push({
    jti: LICENSE_JTIS[0],
    last4: LICENSE_JTIS[0].slice(-4),
    key_hash: 'fx-keyhash-0',
    days: 30,
    iat: Math.floor(l0CreatedAt / 1000),
    exp: Math.floor(l0CreatedAt / 1000) + 30 * 86400,
    revoked: 1,
    created_at: l0CreatedAt,
    created_by: FIXTURE_EMAIL,
    group_id: null,
    tier: 'metis',
    member: 'former.contractor@example.com',
    activated_device: null,
    activated_at: null
  })
  const l1CreatedAt = now - 25 * DAY
  rows.push({
    jti: LICENSE_JTIS[1],
    last4: LICENSE_JTIS[1].slice(-4),
    key_hash: 'fx-keyhash-1',
    days: 7,
    iat: Math.floor(l1CreatedAt / 1000),
    exp: Math.floor(l1CreatedAt / 1000) + 7 * 86400,
    revoked: 1,
    created_at: l1CreatedAt,
    created_by: FIXTURE_EMAIL,
    group_id: null,
    tier: 'metis-light',
    member: 'intern.trial@example.com',
    activated_device: null,
    activated_at: null
  })

  // L2: active, not revoked, expiring in 5 days. Not yet claimed by a seat.
  const l2ExpSec = Math.floor((now + 5 * DAY) / 1000)
  const l2Days = 90
  const l2IatSec = l2ExpSec - l2Days * 86400
  rows.push({
    jti: LICENSE_JTIS[2],
    last4: LICENSE_JTIS[2].slice(-4),
    key_hash: 'fx-keyhash-2',
    days: l2Days,
    iat: l2IatSec,
    exp: l2ExpSec,
    revoked: 0,
    created_at: l2IatSec * 1000,
    created_by: FIXTURE_EMAIL,
    group_id: GROUP_LEADERSHIP,
    tier: 'metis',
    member: 'new.leader@example.com',
    activated_device: null,
    activated_at: null
  })

  // L3..L7: active, each activated to one of the pending seats (keys work through the license,
  // not through a manual approval, exercising the "revoke always wins, license or approve either
  // grants" rule in fleet.ts#seatAuthorizedForKeys).
  const activations: { deviceId: string; days: number; createdOffsetDays: number; tier: string; groupId: string | null }[] = [
    { deviceId: 'seat-ca-02', days: 365, createdOffsetDays: 100, tier: 'metis', groupId: GROUP_DELIVERY_MONTREAL },
    { deviceId: 'seat-fr-02', days: 90, createdOffsetDays: 40, tier: 'metis-light', groupId: GROUP_SALES_PARIS },
    { deviceId: 'seat-de-02', days: 30, createdOffsetDays: 10, tier: 'metis', groupId: null },
    { deviceId: 'seat-br-02', days: 90, createdOffsetDays: 50, tier: 'metis-light', groupId: null },
    { deviceId: 'seat-in-02', days: 30, createdOffsetDays: 5, tier: 'metis', groupId: null }
  ]
  activations.forEach((a, i) => {
    const jti = LICENSE_JTIS[3 + i]
    const createdAt = now - a.createdOffsetDays * DAY
    const iat = Math.floor(createdAt / 1000)
    rows.push({
      jti,
      last4: jti.slice(-4),
      key_hash: `fx-keyhash-${3 + i}`,
      days: a.days,
      iat,
      exp: iat + a.days * 86400,
      revoked: 0,
      created_at: createdAt,
      created_by: FIXTURE_EMAIL,
      group_id: a.groupId,
      tier: a.tier,
      member: emailOf(a.deviceId),
      activated_device: a.deviceId,
      activated_at: createdAt + HOUR
    })
  })

  return rows
}

// ---------------------------------------------------------------------------
// Groups: 3 groups, 2 tiers, members.
// ---------------------------------------------------------------------------

function buildGroups(now: number): { groups: GroupRow[]; members: GroupMemberRow[] } {
  const groups: GroupRow[] = [
    { id: GROUP_SALES_PARIS, name: 'Sales Paris', tier: 'metis-light', notes: null, created_at: now - 70 * DAY, created_by: FIXTURE_EMAIL },
    { id: GROUP_DELIVERY_MONTREAL, name: 'Delivery Montreal', tier: 'metis', notes: null, created_at: now - 65 * DAY, created_by: FIXTURE_EMAIL },
    { id: GROUP_LEADERSHIP, name: 'Leadership', tier: 'metis', notes: null, created_at: now - 90 * DAY, created_by: FIXTURE_EMAIL }
  ]
  const members: GroupMemberRow[] = [
    { group_id: GROUP_SALES_PARIS, member: 'hugo.bernard@example.com', kind: 'email', added_at: now - 69 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_SALES_PARIS, member: 'camille.dubois@example.com', kind: 'email', added_at: now - 69 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_DELIVERY_MONTREAL, member: 'marc.tremblay@example.com', kind: 'email', added_at: now - 64 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_DELIVERY_MONTREAL, member: 'seat-ca-01', kind: 'device', added_at: now - 64 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_LEADERSHIP, member: 'ava.johnson@example.com', kind: 'email', added_at: now - 89 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_LEADERSHIP, member: 'sofia.oliveira@example.com', kind: 'email', added_at: now - 89 * DAY, added_by: FIXTURE_EMAIL },
    { group_id: GROUP_LEADERSHIP, member: 'ananya.sharma@example.com', kind: 'email', added_at: now - 89 * DAY, added_by: FIXTURE_EMAIL }
  ]
  return { groups, members }
}

// ---------------------------------------------------------------------------
// Tiers: metis and metis-light, from the same defaults the migration runner seeds.
// ---------------------------------------------------------------------------

function buildTiers(now: number): TierRow[] {
  return [
    { id: 'metis', label: 'Metis', entitlements_json: JSON.stringify(['ask', 'listen', 'recap', 'crm_push', 'operator_keys', 'intelligence', 'integrations']), updated_at: now - 90 * DAY },
    { id: 'metis-light', label: 'Metis Light', entitlements_json: JSON.stringify(['ask', 'intelligence']), updated_at: now - 90 * DAY }
  ]
}

// ---------------------------------------------------------------------------
// Connectors: 5 integrations (hubspot, clickup, plane, notion, custom-mcp), 2 failing.
// ---------------------------------------------------------------------------

type ConnectorProbeSeed =
  | { ok: true; latencyMs: number; summary: string }
  | { ok: false; latencyMs: number; summary: string; error: { code: string; message: string } }

type ConnectorSeed = {
  id: string
  kind: string
  label: string
  baseUrl: string
  createdOffsetDays: number
  lastUsedOffsetHours: number
  uses: number
  scope: string
  /** The fixture's own last-test outcome. Real health is derived (task 6.10c, `deriveHealth()` in
   *  `connectors/summary.ts`) from `last_test_json`/`last_test_at`, never from `status` -- `status`
   *  below is always `'active'`, exactly like a real, never-revoked connection, so `dashboard.ts`'s
   *  `connectors` field (and `connectors.fixture.ts`'s `fixtureForConnectors()`, which now just
   *  reads that same field) show real 'connected'/'failing' health the same way production does. */
  probe: ConnectorProbeSeed
}

const CONNECTOR_SEEDS: ConnectorSeed[] = [
  {
    id: 'int-hubspot',
    kind: 'hubspot',
    label: 'HubSpot CRM',
    baseUrl: 'https://api.hubapi.com',
    createdOffsetDays: 70,
    lastUsedOffsetHours: 2,
    uses: 128,
    scope: '{"tiers":["metis","metis-light"],"groups":[]}',
    probe: { ok: true, latencyMs: 180, summary: 'Reached HubSpot account 88213291.' }
  },
  {
    id: 'int-clickup',
    kind: 'clickup',
    label: 'ClickUp workspace',
    baseUrl: 'https://api.clickup.com/api/v2',
    createdOffsetDays: 55,
    lastUsedOffsetHours: 6,
    uses: 76,
    scope: `{"tiers":["metis"],"groups":["${GROUP_DELIVERY_MONTREAL}"]}`,
    probe: { ok: true, latencyMs: 220, summary: 'Reached ClickUp as amaris-ops.' }
  },
  {
    id: 'int-plane',
    kind: 'plane',
    label: 'Plane project tracker',
    baseUrl: 'https://api.plane.so',
    createdOffsetDays: 30,
    lastUsedOffsetHours: 96,
    uses: 12,
    scope: '{"tiers":["metis"],"groups":[]}',
    // Plane's catalog entry ships no probe spec at all (no cheap, documented "who am I" endpoint --
    // see connectors/catalog.ts's own comment on the kind), so a real Test connection against it
    // always answers exactly this: never a fabricated upstream status code for a kind that cannot
    // produce one.
    probe: { ok: false, latencyMs: 0, summary: 'No probe available for this kind yet.', error: { code: 'no-probe', message: 'No probe available for this kind yet.' } }
  },
  {
    id: 'int-notion',
    kind: 'notion',
    label: 'Notion knowledge base',
    baseUrl: 'https://api.notion.com/v1',
    createdOffsetDays: 20,
    lastUsedOffsetHours: 4,
    uses: 54,
    scope: '{"tiers":["metis","metis-light"],"groups":[]}',
    probe: { ok: true, latencyMs: 340, summary: 'Reached Notion as integration Metis Bot.' }
  },
  {
    id: 'int-custom-mcp',
    kind: 'custom-mcp',
    label: 'Custom MCP server',
    baseUrl: 'https://mcp.example.com/metis',
    createdOffsetDays: 10,
    lastUsedOffsetHours: 120,
    uses: 3,
    scope: `{"tiers":["metis"],"groups":["${GROUP_LEADERSHIP}"]}`,
    probe: {
      ok: false,
      latencyMs: 10000,
      summary: 'Could not complete the MCP handshake.',
      error: { code: 'timeout', message: 'Timed out after 10 seconds.' }
    }
  }
]

/** `IntegrationRow` plus the additive `integrations` columns task B2 added
 *  (`operator/src/connectors/data.ts`'s `IntegrationExtraColumns`) as plain extra properties on the
 *  same object -- exactly how a real D1 `SELECT *` row carries them, and exactly what
 *  `readIntegrationExtra()` (called by `deriveHealth()`/`integrationSummary()`) already expects to
 *  read off any row it is given, memory-store or D1. */
type FixtureIntegrationRow = IntegrationRow & {
  auth_kind: string | null
  header_name: string | null
  transport: string | null
  mode: 'brokered' | 'direct'
  allow_writes: 0 | 1
  config_json: string
  tools_json: string | null
  last_test_json: string | null
  last_test_at: number | null
  notes: string | null
}

function buildIntegrations(now: number, rng: () => number): { integrations: IntegrationRow[]; grants: IntegrationGrantRow[] } {
  const integrations: FixtureIntegrationRow[] = CONNECTOR_SEEDS.map((c, i) => {
    const entry = getConnectorCatalogEntry(c.kind)
    return {
      id: c.id,
      kind: c.kind,
      label: c.label,
      base_url: c.baseUrl,
      cipher: placeholderCipher(rng, 64),
      iv: placeholderCipher(rng, 12),
      last4: fnvHex(c.id).slice(-4),
      scope_json: c.scope,
      // Real rows only ever carry 'active' | 'revoked' (routes/integrations.ts's entitledInScopeRows()
      // reads strictly 'active'); none of these five is revoked, so every seed is 'active' here,
      // exactly like production. The probe outcome below, not this field, decides connected/failing.
      status: 'active',
      created_at: now - c.createdOffsetDays * DAY,
      created_by: FIXTURE_EMAIL,
      rotated_at: i === 0 ? now - 15 * DAY : null,
      revoked_at: null,
      last_used_at: now - c.lastUsedOffsetHours * HOUR,
      uses: c.uses,
      auth_kind: entry?.auth ?? null,
      header_name: entry?.headerName ?? null,
      transport: entry?.transport ?? null,
      mode: 'brokered',
      allow_writes: 0,
      config_json: '{}',
      tools_json: null,
      last_test_json: JSON.stringify(c.probe),
      last_test_at: now - c.lastUsedOffsetHours * HOUR,
      notes: null
    }
  })
  const grantDevices: Record<string, string[]> = {
    'int-hubspot': ['seat-ca-01', 'seat-fr-01'],
    'int-clickup': ['seat-de-01', 'seat-us-01'],
    'int-notion': ['seat-br-01', 'seat-in-01'],
    'int-plane': ['seat-us-01'],
    'int-custom-mcp': ['seat-fr-01']
  }
  const grants: IntegrationGrantRow[] = []
  let seq = 0
  for (const [integrationId, deviceIds] of Object.entries(grantDevices)) {
    deviceIds.forEach((deviceId, i) => {
      seq++
      grants.push({
        id: `fx-grant-${seq}`,
        integration_id: integrationId,
        device_id: deviceId,
        ts: now - (i + 1) * 6 * HOUR
      })
    })
  }
  return { integrations, grants }
}

// ---------------------------------------------------------------------------
// CRM sends: 6 rows across 6 distinct statuses.
// ---------------------------------------------------------------------------

function buildCrmSends(now: number): CrmSendRow[] {
  return [
    {
      id: 'fx-crm-0',
      device_id: 'seat-ca-01',
      ts: now - 2 * HOUR,
      status: 'pending',
      title: 'Lea Martin weekly sync recap',
      connector: 'hubspot',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-0'),
      last_error: null,
      retry_requested: 0,
      attempt: 1,
      latency_ms: 0,
      remote_id: null,
      remote_url: null,
      action: 'create_note'
    },
    {
      id: 'fx-crm-1',
      device_id: 'seat-fr-01',
      ts: now - 5 * HOUR,
      status: 'in_progress',
      title: 'Camille Dubois discovery call recap',
      connector: 'hubspot',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-1'),
      last_error: null,
      retry_requested: 0,
      attempt: 1,
      latency_ms: 1200,
      remote_id: null,
      remote_url: null,
      action: 'create_note'
    },
    {
      id: 'fx-crm-2',
      device_id: 'seat-de-01',
      ts: now - 1 * DAY,
      status: 'in_review',
      title: 'Mia Fischer project update',
      connector: 'notion',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-2'),
      last_error: null,
      retry_requested: 0,
      attempt: 1,
      latency_ms: 900,
      remote_id: null,
      remote_url: null,
      action: 'create_page'
    },
    {
      id: 'fx-crm-3',
      device_id: 'seat-us-01',
      ts: now - 1 * DAY - 3 * HOUR,
      status: 'success',
      title: 'Ava Johnson sprint recap',
      connector: 'clickup',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-3'),
      last_error: null,
      retry_requested: 0,
      attempt: 1,
      latency_ms: 850,
      remote_id: 'CU-4821',
      remote_url: 'https://app.clickup.com/t/CU-4821',
      action: 'create_task'
    },
    {
      id: 'fx-crm-4',
      device_id: 'seat-br-01',
      ts: now - 2 * DAY,
      status: 'failed',
      title: 'Sofia Oliveira client review recap',
      connector: 'plane',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-4'),
      last_error: 'Upstream responded 503',
      retry_requested: 1,
      attempt: 2,
      latency_ms: 3400,
      remote_id: null,
      remote_url: null,
      action: 'create_issue'
    },
    {
      id: 'fx-crm-5',
      device_id: 'seat-in-01',
      ts: now - 6 * DAY,
      status: 'expired',
      title: 'Ananya Sharma handoff recap',
      connector: 'notion',
      meeting_file: null,
      meeting_hash: fnvHex('fx-crm-5'),
      last_error: 'Retry window elapsed',
      retry_requested: 0,
      attempt: 3,
      latency_ms: 0,
      remote_id: null,
      remote_url: null,
      action: 'create_page'
    }
  ]
}

// ---------------------------------------------------------------------------
// Skill proposals: 3 rows, one of each disposition.
// ---------------------------------------------------------------------------

function buildProposals(now: number): ProposalRow[] {
  return [
    {
      id: 'fx-proposal-0',
      skill_id: 'interview-prep',
      from_version: '2.3.0',
      evidence_json: JSON.stringify(['18 behavioral asks in the last 7 days', '2 ratings marked down on multi part answers']),
      diff: '- Ask one behavioral question at a time.\n+ Ask one behavioral question at a time and note the STAR structure before moving on.',
      rationale: 'Behavioral asks get more follow up questions than other interview asks this week.',
      status: 'pending',
      created_by: FIXTURE_EMAIL,
      created_at: now - 2 * DAY,
      decided_at: null,
      reject_reason: null
    },
    {
      id: 'fx-proposal-1',
      skill_id: 'recap-writer',
      from_version: '1.9.2',
      evidence_json: JSON.stringify(['Recap length above the target range on 9 of 14 meetings', 'Two seats asked for a shorter summary']),
      diff: '- Summarize the whole meeting in one pass.\n+ Summarize in two passes: decisions first, then context, capped at 200 words.',
      rationale: 'Shorter recaps matched what seats asked for in ratings and follow up asks.',
      status: 'approved',
      created_by: FIXTURE_EMAIL,
      created_at: now - 6 * DAY,
      decided_at: now - 5 * DAY,
      reject_reason: null
    },
    {
      id: 'fx-proposal-2',
      skill_id: 'support-triage',
      from_version: '1.4.0',
      evidence_json: JSON.stringify(['3 asks tagged support-triage in the last 30 days']),
      diff: '- Route every ticket to the same queue.\n+ Route by keyword match against the last 3 categories.',
      rationale: 'Not enough asks yet to justify a routing change.',
      status: 'rejected',
      created_by: FIXTURE_EMAIL,
      created_at: now - 20 * DAY,
      decided_at: now - 18 * DAY,
      reject_reason: 'Evidence too thin, only 3 asks in 30 days.'
    }
  ]
}

// ---------------------------------------------------------------------------
// Audit rows.
// ---------------------------------------------------------------------------

type FixtureAuditRow = AuditRow & { id: string }

function buildAudit(now: number): FixtureAuditRow[] {
  return [
    { id: 'fx-audit-0', ts: now - 90 * DAY, actor: FIXTURE_EMAIL, action: 'license-generate', ask_id: null, detail: `30d license ··${LICENSE_JTIS[0].slice(-4)}`, request_id: 'req-fx-0', route: '/v1/admin/licenses/generate' },
    { id: 'fx-audit-1', ts: now - 55 * DAY, actor: FIXTURE_EMAIL, action: 'license-revoke', ask_id: null, detail: `revoked ··${LICENSE_JTIS[0].slice(-4)}`, request_id: 'req-fx-1', route: '/v1/admin/licenses/revoke' },
    { id: 'fx-audit-2', ts: now - 24 * DAY, actor: FIXTURE_EMAIL, action: 'license-revoke', ask_id: null, detail: `revoked ··${LICENSE_JTIS[1].slice(-4)}`, request_id: 'req-fx-2', route: '/v1/admin/licenses/revoke' },
    { id: 'fx-audit-3', ts: now - 40 * HOUR, actor: FIXTURE_EMAIL, action: 'seat-approve', ask_id: null, detail: 'seat-ca-01 approved', request_id: 'req-fx-3', route: '/v1/admin/licenses/approve' },
    { id: 'fx-audit-4', ts: now - 2 * DAY, actor: FIXTURE_EMAIL, action: 'seat-revoke', ask_id: null, detail: 'seat-us-02 revoked', request_id: 'req-fx-4', route: '/v1/admin/licenses/revoke' },
    { id: 'fx-audit-5', ts: now - 15 * DAY, actor: FIXTURE_EMAIL, action: 'integration-rotate', ask_id: null, detail: 'hubspot credential rotated', request_id: 'req-fx-5', route: '/v1/admin/integrations/int-hubspot/rotate' },
    { id: 'fx-audit-6', ts: now - 4 * DAY, actor: FIXTURE_EMAIL, action: 'integration-test-failed', ask_id: null, detail: 'plane test failed, 503', request_id: 'req-fx-6', route: '/v1/admin/integrations/int-plane/test' },
    { id: 'fx-audit-7', ts: now - 5 * DAY, actor: FIXTURE_EMAIL, action: 'integration-test-failed', ask_id: null, detail: 'custom-mcp test failed, timeout', request_id: 'req-fx-7', route: '/v1/admin/integrations/int-custom-mcp/test' },
    { id: 'fx-audit-8', ts: now - 5 * DAY, actor: FIXTURE_EMAIL, action: 'skill-approve', ask_id: null, detail: 'recap-writer 1.9.2 approved', request_id: 'req-fx-8', route: '/v1/admin/skills/approve' }
  ]
}

// ---------------------------------------------------------------------------
// Heartbeat pulses and asks: 7 days per seat.
// ---------------------------------------------------------------------------

const MODES = ['answer', 'interview', 'screen'] as const
const PROVIDER_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4.1',
  cloudflare: '@cf/meta/llama-3.1-8b-instruct'
}
const PROVIDER_WEIGHTS = [
  ['anthropic', 55],
  ['openai', 30],
  ['cloudflare', 15]
] as const
const QUESTION_TYPE_POOL = QUESTION_TYPES.filter((t): t is Exclude<QuestionType, 'unknown'> => t !== 'unknown')

function buildAsksAndPulses(
  now: number,
  seats: SeatRow[],
  rng: () => number
): { asks: AskRow[]; pulses: PulseRow[] } {
  const asks: AskRow[] = []
  const pulses: PulseRow[] = []

  for (const seat of seats) {
    for (let offset = 0; offset < 7; offset++) {
      const dayStart = now - (offset + 1) * DAY
      const heartbeatCount = intBetween(rng, 3, 9)
      for (let h = 0; h < heartbeatCount; h++) {
        const ts = dayStart + Math.floor(rng() * (DAY - 1))
        pulses.push({
          id: `fx-hb-${seat.device_id}-${offset}-${h}`,
          device_id: seat.device_id,
          ts,
          kind: 'heartbeat',
          country: seat.country,
          city: seat.city,
          region: seat.region ?? undefined
        })
      }
      const askCount = intBetween(rng, 0, 5)
      for (let a = 0; a < askCount; a++) {
        const ts = dayStart + Math.floor(rng() * (DAY - 1))
        const provider = weightedPick(rng, PROVIDER_WEIGHTS)
        const model = PROVIDER_MODELS[provider]
        const mode = pick(rng, MODES)
        const questionType = chance(rng, 0.9) ? pick(rng, QUESTION_TYPE_POOL) : null
        const cacheRoll = rng()
        let cacheRead: number | null = 0
        let cacheWrite: number | null = 0
        let cacheUncached: number | null = 0
        let cacheStatus: string
        let cacheTtl: string | null
        if (cacheRoll < 0.08) {
          cacheRead = null
          cacheWrite = null
          cacheUncached = null
          cacheStatus = 'not-reported'
          cacheTtl = null
        } else if (cacheRoll < 0.55) {
          cacheRead = intBetween(rng, 200, 3000)
          cacheUncached = intBetween(rng, 20, 300)
          cacheStatus = 'hit'
          cacheTtl = pick(rng, ['1h', '5m'] as const)
        } else {
          cacheWrite = intBetween(rng, 100, 2000)
          cacheUncached = intBetween(rng, 50, 600)
          cacheStatus = 'write'
          cacheTtl = pick(rng, ['1h', '5m'] as const)
        }
        const isError = chance(rng, 0.05)
        const ratingRoll = rng()
        const rating = ratingRoll < 0.06 ? 'down' : ratingRoll < 0.22 ? 'up' : null
        const outcome = isError ? 'error' : rating === 'down' ? 'thumbs-down' : 'answered'
        const label = questionType ? QUESTION_TYPE_LABELS[questionType] : QUESTION_TYPE_LABELS.unknown
        const askId = `fx-ask-${seat.device_id}-${offset}-${a}`
        asks.push({
          id: askId,
          device_id: seat.device_id,
          ts,
          mode,
          skill_id: null,
          skill_version: null,
          provider,
          model,
          ttft_ms: intBetween(rng, 120, 900),
          total_ms: intBetween(rng, 800, 20000),
          input_tokens: intBetween(rng, 150, 2200),
          output_tokens: intBetween(rng, 40, 900),
          cache_read: cacheRead,
          cache_write: cacheWrite,
          cache_uncached: cacheUncached,
          cache_status: cacheStatus,
          cache_ttl: cacheTtl,
          outcome,
          rating,
          prompt_cipher: placeholderCipher(rng, intBetween(rng, 48, 96)),
          prompt_iv: placeholderCipher(rng, 12),
          preview: `${mode} ask, ${label.toLowerCase()}`,
          question_type: questionType
        })
        pulses.push({
          id: `fx-pulse-ask-${askId}`,
          device_id: seat.device_id,
          ts,
          kind: 'ask',
          country: seat.country,
          city: seat.city,
          region: seat.region ?? undefined
        })
      }
    }
    // Anchor pulse at the seat's own last_seen so the live/idle state on every page agrees with
    // seats.last_seen exactly (plan: 4 seats live within 2 minutes of `now`).
    pulses.push({
      id: `fx-hb-${seat.device_id}-latest`,
      device_id: seat.device_id,
      ts: seat.last_seen,
      kind: 'heartbeat',
      country: seat.country,
      city: seat.city,
      region: seat.region ?? undefined
    })
  }
  return { asks, pulses }
}

function buildRecapEvents(now: number, seats: SeatRow[], rng: () => number): EventRow[] {
  const events: EventRow[] = []
  for (const seat of seats) {
    for (let r = 0; r < 2; r++) {
      const offset = intBetween(rng, 0, 6)
      const ts = now - offset * DAY - intBetween(rng, 0, DAY - 1)
      const minutes = intBetween(rng, 10, 60)
      events.push({
        id: `fx-recap-${seat.device_id}-${r}`,
        ts,
        kind: 'recap',
        actor: seat.sso_email,
        device_id: seat.device_id,
        country: seat.country,
        detail: `${minutes}m`
      })
    }
  }
  return events
}

function buildCrmEvents(crmSends: CrmSendRow[], seatsById: Map<string, SeatRow>): EventRow[] {
  return crmSends.map((c) => ({
    id: `fx-event-crm-${c.id}`,
    ts: c.ts,
    kind: 'crm',
    actor: seatsById.get(c.device_id)?.sso_email ?? null,
    device_id: c.device_id,
    country: seatsById.get(c.device_id)?.country ?? null,
    detail: c.status
  }))
}

/** Pure replay of the same 2 minute gap algorithm `OperatorStore#touchSession` uses, so
 *  `seed-local.mjs` can write finished `sessions` rows straight into D1 without a live store. */
function replaySessions(pulses: PulseRow[], seatsById: Map<string, SeatRow>): SessionState[] {
  const sorted = pulses.slice().sort((a, b) => a.ts - b.ts)
  const openByDevice = new Map<string, SessionState>()
  const closed: SessionState[] = []
  let seq = 0
  for (const p of sorted) {
    const seat = seatsById.get(p.device_id)
    const result = applyPulse(
      openByDevice.get(p.device_id) ?? null,
      {
        deviceId: p.device_id,
        ts: p.ts,
        kind: p.kind as PulseKind,
        country: p.country,
        city: p.city,
        os: seat?.os ?? null,
        appVersion: seat?.app_version ?? null
      },
      () => `fx-session-${p.device_id}-${++seq}`
    )
    if (result.closed) closed.push(result.closed)
    openByDevice.set(p.device_id, result.session)
  }
  return [...closed, ...openByDevice.values()]
}

// ---------------------------------------------------------------------------
// Assembly.
// ---------------------------------------------------------------------------

export interface FixtureRows {
  now: number
  seats: SeatRow[]
  pulses: PulseRow[]
  asks: AskRow[]
  events: EventRow[]
  issuedLicenses: IssuedLicenseRow[]
  groups: GroupRow[]
  groupMembers: GroupMemberRow[]
  tiers: TierRow[]
  integrations: IntegrationRow[]
  integrationGrants: IntegrationGrantRow[]
  crmSends: CrmSendRow[]
  proposals: ProposalRow[]
  audit: FixtureAuditRow[]
  sessions: SessionState[]
}

/** Deterministic fixture seed. Fixed, not derived from `now`, so the same rows come out for any
 *  caller: only the wall clock offsets (7 day window, license expiries) move with `now`. */
const PRNG_SEED = 0x4d455449

export function fixtureRows(now: number = FIXTURE_NOW): FixtureRows {
  const rng = mulberry32(PRNG_SEED)

  const seats: SeatRow[] = SEAT_SEEDS.map((seed) => ({
    device_id: seed.deviceId,
    seat_hash: `fx-hash-${fnvHex(seed.deviceId)}`,
    os: seed.os,
    app_version: seed.appVersion,
    first_seen: now - seed.firstSeenOffsetMs,
    last_seen: now - seed.lastSeenOffsetMs,
    country: seed.country,
    city: seed.city,
    region: seed.region,
    lat: seed.lat,
    lon: seed.lon,
    last_index_at: null,
    hostname: seatHostname(seed),
    sso_email: seatEmail(seed),
    license: seed.license,
    approval: seed.approval,
    license_jti: null
  }))
  const seatsById = new Map(seats.map((s) => [s.device_id, s]))

  const issuedLicenses = buildIssuedLicenses(now, seats)
  const activatedJtiByDevice = new Map<string, string>()
  for (const lic of issuedLicenses) {
    if (lic.activated_device) activatedJtiByDevice.set(lic.activated_device, lic.jti)
  }
  for (const seat of seats) {
    const jti = activatedJtiByDevice.get(seat.device_id)
    if (jti) seat.license_jti = jti
  }

  const { groups, members: groupMembers } = buildGroups(now)
  const tiers = buildTiers(now)
  const { integrations, grants: integrationGrants } = buildIntegrations(now, rng)
  const crmSends = buildCrmSends(now)
  const proposals = buildProposals(now)
  const audit = buildAudit(now)
  const { asks, pulses } = buildAsksAndPulses(now, seats, rng)
  const events = [...buildRecapEvents(now, seats, rng), ...buildCrmEvents(crmSends, seatsById)]
  const sessions = replaySessions(pulses, seatsById)

  return {
    now,
    seats,
    pulses,
    asks,
    events,
    issuedLicenses,
    groups,
    groupMembers,
    tiers,
    integrations,
    integrationGrants,
    crmSends,
    proposals,
    audit,
    sessions
  }
}

/** Seeds any `OperatorStore` implementation (memory or D1) with `fixtureRows()`. Pulses are
 *  replayed through `touchSession` in timestamp order so a memory store ends up with the exact
 *  same session rows `replaySessions` computed for the SQL path. */
export async function seedStore(store: OperatorStore, rows: FixtureRows): Promise<void> {
  for (const seat of rows.seats) await store.upsertSeat(seat)

  const seatsById = new Map(rows.seats.map((s) => [s.device_id, s]))
  const sortedPulses = rows.pulses.slice().sort((a, b) => a.ts - b.ts)
  for (const p of sortedPulses) {
    await store.insertPulse(p)
    const seat = seatsById.get(p.device_id)
    await store.touchSession(p.device_id, p.ts, p.kind, { country: p.country, city: p.city }, { os: seat?.os ?? null, app_version: seat?.app_version ?? null })
  }

  for (const ask of rows.asks) await store.insertAsk(ask)
  for (const event of rows.events) await store.insertEvent(event)
  for (const lic of rows.issuedLicenses) await store.putIssuedLicense(lic)
  for (const group of rows.groups) await store.putGroup(group)
  for (const member of rows.groupMembers) await store.putGroupMember(member)
  for (const tier of rows.tiers) await store.putTier(tier)
  for (const integration of rows.integrations) await store.putIntegration(integration)
  for (const grant of rows.integrationGrants) await store.insertIntegrationGrant(grant)
  for (const crm of rows.crmSends) await store.upsertCrm(crm)
  for (const proposal of rows.proposals) await store.putProposal(proposal)
  for (const row of rows.audit) {
    await store.audit(row.id, row.ts, row.actor, row.action, row.ask_id, row.detail, {
      requestId: row.request_id ?? undefined,
      route: row.route ?? undefined
    })
  }
}

/** The full `DashboardPayload` for the fixture, built through the real `buildDashboard` (plan
 *  lock: no hand typed KPI values). Every number on a preview page traces back to a fixture row. */
export async function fixtureDashboard(now: number = FIXTURE_NOW): Promise<DashboardPayload> {
  const rows = fixtureRows(now)
  const store = memoryStore()
  await seedStore(store, rows)
  return buildDashboard(store, FIXTURE_EMAIL, now)
}

/** Exported for the gates/audit scripts and tests that need to reason about live seats without
 *  re-deriving the 2 minute window. */
export const FIXTURE_ONLINE_MS = ONLINE_MS
