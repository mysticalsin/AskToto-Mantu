import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

const MAX_PLAN_FILES = 128
const MAX_PLAN_PATH_BYTES = 16_384
const MAX_PLAN_BYTES = 100_000_000_000
const MAX_COMPONENT_ID_BYTES = 128
const MAX_VERSION_BYTES = 128
const SHA256_PATTERN = /^[a-f0-9]{64}$/

declare const runtimePayloadWritePlanBrand: unique symbol
declare const runtimePayloadFilePinBrand: unique symbol

export type RuntimePayloadWritePlan = { readonly [runtimePayloadWritePlanBrand]: true }
export type RuntimePayloadFilePin = { readonly [runtimePayloadFilePinBrand]: true }

export interface RuntimePayloadPlanIssuer {
  issue(input: {
    readonly componentId: string
    readonly componentVersion: string
    readonly manifestIdentity: string
    readonly resourcePolicyIdentity: string
    readonly rootRelativePath: string
    readonly files: readonly {
      readonly relativePath: string
      readonly byteLength: number
      readonly sha256: string
    }[]
    readonly admittedMaximumBytes: number
    readonly admittedMaximumFiles: number
    readonly admittedMaximumPathBytes: number
  }): RuntimePayloadWritePlan
  retire(): void
}

interface PlannedFile {
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
  readonly ancestors: readonly string[]
  used: boolean
}

interface PlanState {
  readonly identity: string
  readonly rootRelativePath: string
  readonly files: Map<string, PlannedFile>
  readonly directories: Set<string>
  readonly totalBytes: number
  readonly maximumBytes: number
  readonly maximumPathBytes: number
  readonly maximumFiles: number
  retired: boolean
}

const plans = new WeakMap<object, PlanState>()
const filePins = new WeakMap<object, { readonly plan: PlanState; readonly file: PlannedFile }>()

function safeRelativePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  ) {
    throw new Error('RUNTIME_PAYLOAD_PATH_INVALID')
  }
  return value
}

function directoryAncestors(path: string): string[] {
  const result: string[] = []
  const parts = path.split('/')
  for (let index = 1; index < parts.length; index++) result.push(parts.slice(0, index).join('/'))
  return result
}

/**
 * This factory is for the production main-composition boundary. Its caller must
 * pass only the compiled catalog entry and the active resource-policy result.
 * The returned handles are opaque; raw byte maxima never reach tree writers.
 */
export function createRuntimePayloadPlanIssuer(): RuntimePayloadPlanIssuer {
  let retired = false
  const issued: PlanState[] = []
  return Object.freeze({
    issue(input: Parameters<RuntimePayloadPlanIssuer['issue']>[0]): RuntimePayloadWritePlan {
      if (retired) throw new Error('RUNTIME_PAYLOAD_ISSUER_RETIRED')
      const rootRelativePath = safeRelativePath(input.rootRelativePath)
      if (
        !input.componentId ||
        Buffer.byteLength(input.componentId) > MAX_COMPONENT_ID_BYTES ||
        !input.componentVersion ||
        Buffer.byteLength(input.componentVersion) > MAX_VERSION_BYTES ||
        !SHA256_PATTERN.test(input.manifestIdentity) ||
        !input.resourcePolicyIdentity ||
        Buffer.byteLength(input.resourcePolicyIdentity) > MAX_VERSION_BYTES ||
        !Number.isSafeInteger(input.admittedMaximumBytes) ||
        input.admittedMaximumBytes <= 0 ||
        input.admittedMaximumBytes > MAX_PLAN_BYTES ||
        !Number.isSafeInteger(input.admittedMaximumFiles) ||
        input.admittedMaximumFiles <= 0 ||
        input.admittedMaximumFiles > MAX_PLAN_FILES ||
        !Number.isSafeInteger(input.admittedMaximumPathBytes) ||
        input.admittedMaximumPathBytes <= 0 ||
        input.admittedMaximumPathBytes > MAX_PLAN_PATH_BYTES ||
        input.files.length === 0 ||
        input.files.length > input.admittedMaximumFiles
      ) {
        throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
      }
      const files = new Map<string, PlannedFile>()
      const directories = new Set<string>()
      let totalBytes = 0
      let pathBytes = Buffer.byteLength(rootRelativePath)
      for (const item of input.files) {
        const path = safeRelativePath(item.relativePath)
        if (
          files.has(path) ||
          !Number.isSafeInteger(item.byteLength) ||
          item.byteLength <= 0 ||
          !SHA256_PATTERN.test(item.sha256)
        ) {
          throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
        }
        totalBytes += item.byteLength
        pathBytes += Buffer.byteLength(path)
        const ancestors = directoryAncestors(path)
        for (const ancestor of ancestors) {
          directories.add(ancestor)
          pathBytes += Buffer.byteLength(ancestor)
        }
        files.set(path, { path, byteLength: item.byteLength, sha256: item.sha256, ancestors, used: false })
      }
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > input.admittedMaximumBytes ||
        files.size > input.admittedMaximumFiles ||
        pathBytes > input.admittedMaximumPathBytes ||
        directories.size + files.size > MAX_PLAN_FILES
      ) {
        throw new Error('RUNTIME_PAYLOAD_PLAN_BUDGET_EXCEEDED')
      }
      const canonical = JSON.stringify({
        schemaVersion: 1,
        componentId: input.componentId,
        componentVersion: input.componentVersion,
        manifestIdentity: input.manifestIdentity,
        resourcePolicyIdentity: input.resourcePolicyIdentity,
        rootRelativePath,
        files: [...files.values()].map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256 }))
      })
      const state: PlanState = {
        identity: createHash('sha256').update('metis-runtime-payload-plan/v1\0').update(canonical).digest('hex'),
        rootRelativePath,
        files,
        directories,
        totalBytes,
        maximumBytes: input.admittedMaximumBytes,
        maximumPathBytes: input.admittedMaximumPathBytes,
        maximumFiles: input.admittedMaximumFiles,
        retired: false
      }
      if (issued.length >= 128) throw new Error('RUNTIME_PAYLOAD_PLAN_LIMIT')
      issued.push(state)
      const plan = Object.freeze({}) as RuntimePayloadWritePlan
      plans.set(plan, state)
      return plan
    },
    retire(): void {
      if (retired) return
      retired = true
      for (const plan of issued) plan.retired = true
    }
  })
}

export function runtimePayloadPlanRoot(plan: RuntimePayloadWritePlan): string {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  return state.rootRelativePath
}

export function runtimePayloadPlanIdentity(plan: RuntimePayloadWritePlan): string {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  return state.identity
}

export function runtimePayloadDirectoryAllowed(plan: RuntimePayloadWritePlan, relativePath: string): boolean {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  const path = safeRelativePath(relativePath)
  return state.directories.has(path)
}

export function issueRuntimePayloadFilePin(plan: RuntimePayloadWritePlan, relativePath: string): RuntimePayloadFilePin {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  const path = safeRelativePath(relativePath)
  const file = state.files.get(path)
  if (!file || file.used) throw new Error('RUNTIME_PAYLOAD_FILE_PIN_UNAVAILABLE')
  const pin = Object.freeze({}) as RuntimePayloadFilePin
  filePins.set(pin, { plan: state, file })
  return pin
}

export function consumeRuntimePayloadFilePin(
  plan: RuntimePayloadWritePlan,
  pin: RuntimePayloadFilePin
): Readonly<{ path: string; byteLength: number; sha256: string; ancestors: readonly string[] }> {
  const state = plans.get(plan as object)
  const issued = filePins.get(pin as object)
  if (!state || state.retired || !issued || issued.plan !== state || issued.file.used) {
    throw new Error('RUNTIME_PAYLOAD_FILE_PIN_INVALID')
  }
  issued.file.used = true
  return Object.freeze({
    path: issued.file.path,
    byteLength: issued.file.byteLength,
    sha256: issued.file.sha256,
    ancestors: [...issued.file.ancestors]
  })
}

export function runtimePayloadPlanComplete(plan: RuntimePayloadWritePlan): boolean {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  return [...state.files.values()].every((file) => file.used)
}

export function runtimePayloadPlanBudget(plan: RuntimePayloadWritePlan): Readonly<{
  totalBytes: number
  maximumBytes: number
  maximumFiles: number
  maximumPathBytes: number
  fileCount: number
  directoryCount: number
}> {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  return Object.freeze({
    totalBytes: state.totalBytes,
    maximumBytes: state.maximumBytes,
    maximumFiles: state.maximumFiles,
    maximumPathBytes: state.maximumPathBytes,
    fileCount: state.files.size,
    directoryCount: state.directories.size
  })
}

export function runtimePayloadPlanFileClaims(plan: RuntimePayloadWritePlan): readonly Readonly<{
  relativePath: string
  byteLength: number
  sha256: string
}>[] {
  const state = plans.get(plan as object)
  if (!state || state.retired) throw new Error('RUNTIME_PAYLOAD_PLAN_INVALID')
  return Object.freeze(
    [...state.files.values()].map((file) =>
      Object.freeze({ relativePath: file.path, byteLength: file.byteLength, sha256: file.sha256 })
    )
  )
}
