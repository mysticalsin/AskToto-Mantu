/**
 * Local install identity: UUID, first-seen timestamp, sequential member number.
 * Member number is assigned only by the reserved register-install API.
 * Never invent a number. Never rewrite installedAt.
 */
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const IdentityFileSchema = z.object({
  installId: z.string().uuid(),
  installedAt: z.string().min(1),
  memberNumber: z.number().int().positive().nullable(),
  memberNumberAssignedAt: z.string().nullable()
})
export type InstallIdentity = z.infer<typeof IdentityFileSchema>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function identityPath(userData?: string): string {
  return join(userData ?? app.getPath('userData'), 'identity.json')
}

function emptyIdentity(): InstallIdentity {
  return {
    installId: randomUUID(),
    installedAt: new Date().toISOString(),
    memberNumber: null,
    memberNumberAssignedAt: null
  }
}

function persist(path: string, data: InstallIdentity): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readInstallIdentity(userData?: string): InstallIdentity {
  const path = identityPath(userData)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const parsed = IdentityFileSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  } catch {
    /* missing or corrupt */
  }
  const created = emptyIdentity()
  try {
    persist(path, created)
  } catch {
    /* unwritable userData — still return a stable-for-this-process identity */
  }
  return created
}

/**
 * Persist a first-seen identity. `installedAt` and `installId` from disk always win.
 * A real member number (positive int) is cached once and never replaced by null.
 * A fake / pending write cannot overwrite an assigned number.
 */
export function writeInstallIdentity(patch: Partial<InstallIdentity>, userData?: string): InstallIdentity {
  const path = identityPath(userData)
  const current = readInstallIdentity(userData)
  const next: InstallIdentity = {
    installId: current.installId,
    installedAt: current.installedAt,
    memberNumber: current.memberNumber,
    memberNumberAssignedAt: current.memberNumberAssignedAt
  }
  if (current.memberNumber == null && typeof patch.memberNumber === 'number' && patch.memberNumber > 0) {
    next.memberNumber = Math.floor(patch.memberNumber)
    next.memberNumberAssignedAt = patch.memberNumberAssignedAt ?? new Date().toISOString()
  }
  try {
    persist(path, next)
  } catch {
    /* best-effort */
  }
  return next
}

export function assignMemberNumber(n: number, userData?: string): InstallIdentity {
  if (!Number.isInteger(n) || n <= 0) return readInstallIdentity(userData)
  return writeInstallIdentity({ memberNumber: n, memberNumberAssignedAt: new Date().toISOString() }, userData)
}

export function formatInstalledLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Installed'
  return `Installed ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function memberNumberLabel(n: number | null): string {
  return n == null ? 'pending' : String(n)
}
