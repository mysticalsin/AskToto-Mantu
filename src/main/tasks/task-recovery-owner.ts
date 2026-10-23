import type { TaskRecoveryOwner } from './task-contract'

const RECOVERY_KEY = /^[a-f0-9]{64}$/

export function isTaskRecoveryOwner(value: unknown): value is TaskRecoveryOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  const keys = Object.keys(owner)
  return (
    keys.length === 2 &&
    keys.includes('ownerKey') &&
    keys.includes('tenantKey') &&
    typeof owner.ownerKey === 'string' &&
    RECOVERY_KEY.test(owner.ownerKey) &&
    typeof owner.tenantKey === 'string' &&
    RECOVERY_KEY.test(owner.tenantKey)
  )
}

export function cloneTaskRecoveryOwner(value: unknown): TaskRecoveryOwner | null {
  return isTaskRecoveryOwner(value) ? Object.freeze({ ownerKey: value.ownerKey, tenantKey: value.tenantKey }) : null
}

export function sameTaskRecoveryOwner(a: unknown, b: unknown): boolean {
  return isTaskRecoveryOwner(a) && isTaskRecoveryOwner(b) && a.ownerKey === b.ownerKey && a.tenantKey === b.tenantKey
}
