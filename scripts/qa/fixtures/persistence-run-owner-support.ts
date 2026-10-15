import { createPrivateKey, createHash, sign } from 'node:crypto'
import { mkdir, mkdtemp, lstat, realpath, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { build } from 'esbuild'
import { inject } from 'vitest'
import { readPrivateCurrentUserAclReceipt } from '../../../src/main/win-security'
import { PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT } from '../../../src/main/persistence/native-key-intent'
import {
  QA_HEARTBEAT_SCHEMA,
  QA_LAUNCH_ENVELOPE_SCHEMA,
  compiledQaPersistenceRunContext,
  newQaPersistenceBootChallenge,
  qaPersistenceCanonical,
  type QaPersistenceLaunchPayload
} from '../../../src/main/persistence/qa-run-protocol'

const launchDomain = Buffer.from('metis-persistence-qa-launch/v1\n', 'utf8')
const heartbeatDomain = Buffer.from('metis-persistence-qa-heartbeat/v1\n', 'utf8')
const injectedString = (key: string): string => (inject as unknown as (name: string) => unknown)(key) as string
const fixturePrivateKey = createPrivateKey(injectedString('qaPersistenceFixturePrivateKeyPem'))
const fixtureBuildStamp = injectedString('qaPersistenceFixtureBuildStamp')
const sourceElectronHost = join(__dirname, 'persistence-run-owner.electron-host.ts')
const sourceChild = join(__dirname, 'persistence-run-owner.child.ts')

export type PhysicalDirectoryIdentity = {
  path: string
  device: string
  inode: string
  birthtimeMs: number
  owner: string
  mode: number
}

export type QaFixtureProfile = {
  readonly directory: string
  readonly parent: PhysicalDirectoryIdentity
  readonly profile: PhysicalDirectoryIdentity
  readonly ownerSid: string | null
  cleanup(): Promise<void>
}

function principalAssociation(sid: string): string {
  return createHash('sha256').update('metis-qa-os-principal/v1\n', 'utf8').update(sid, 'utf8').digest('hex')
}

async function physicalIdentity(path: string, ownerSid: string | null): Promise<PhysicalDirectoryIdentity> {
  const canonicalPath = await realpath(path)
  const stat = await lstat(canonicalPath, { bigint: true })
  return {
    path: canonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeMs: Math.round(Number(stat.birthtimeMs)),
    owner: process.platform === 'win32' ? (ownerSid ?? '') : String(process.getuid?.() ?? ''),
    mode: Number(stat.mode) & 0o7777
  }
}

export async function createQaFixtureProfile(): Promise<QaFixtureProfile> {
  const directory = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-'))
  const parentPath = await realpath(directory)
  const profilePath = join(parentPath, 'profile')
  await mkdir(profilePath, { mode: 0o700 })
  if (process.platform === 'darwin') {
    await chmod(parentPath, 0o700)
    await chmod(profilePath, 0o700)
  }
  let ownerSid: string | null = null
  if (process.platform === 'win32') {
    const receipt = await readPrivateCurrentUserAclReceipt(parentPath)
    if (!receipt) throw new Error('Windows QA fixture parent has no fresh private current-user ACL receipt')
    ownerSid = receipt.ownerSid
    const profileReceipt = await readPrivateCurrentUserAclReceipt(profilePath)
    if (!profileReceipt || profileReceipt.ownerSid !== ownerSid)
      throw new Error('Windows QA fixture profile has no matching fresh current-user ACL receipt')
  }
  const parent = await physicalIdentity(parentPath, ownerSid)
  const profile = await physicalIdentity(profilePath, ownerSid)
  return {
    directory,
    parent,
    profile,
    ownerSid,
    cleanup: () => rm(directory, { recursive: true, force: true })
  }
}

export function signQaFixtureLaunch(
  challenge: string,
  physical: Pick<QaFixtureProfile, 'parent' | 'profile' | 'ownerSid'>,
  overrides: Partial<QaPersistenceLaunchPayload> = {}
): Buffer {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) throw new Error('QA fixture stamp is missing')
  const now = Date.now()
  const principal =
    process.platform === 'win32'
      ? {
          platform: 'win32' as const,
          sidAssociationSha256: principalAssociation(physical.ownerSid ?? '')
        }
      : {
          platform: 'darwin' as const,
          uid: process.getuid?.() ?? 0,
          effectiveUid: process.geteuid?.() ?? process.getuid?.() ?? 0
        }
  const payload: QaPersistenceLaunchPayload = {
    purpose: 'isolated-persistence-qualification',
    bootChallenge: challenge,
    sourceCommit: stamp.context.commit,
    buildContext: stamp.context,
    runId: stamp.context.runId,
    runGeneration: 1,
    candidateSha256: stamp.candidateSha256,
    implementationSha256: stamp.implementationSha256,
    profileMeasurementSha256: stamp.profileMeasurementSha256,
    caseRosterSha256: stamp.caseRosterSha256,
    runtime: stamp.runtime,
    qaIdentity: stamp.qaIdentity,
    allowedCases: ['before-show-refusal', 'status-no-side-effects'],
    notBefore: now - 1000,
    expiresAt: now + 60_000,
    profile: physical.profile,
    parent: physical.parent,
    osPrincipalAssociation: principal,
    nativeKeyIntent: PERSISTENCE_ORIGINAL_NATIVE_KEY_INTENT,
    ...overrides
  }
  const payloadBytes = Buffer.from(qaPersistenceCanonical(payload), 'utf8')
  const signature = sign(null, Buffer.concat([launchDomain, payloadBytes]), fixturePrivateKey)
  return Buffer.from(
    qaPersistenceCanonical({
      schema: QA_LAUNCH_ENVELOPE_SCHEMA,
      payload: payloadBytes.toString('base64url'),
      signature: signature.toString('base64url')
    }),
    'utf8'
  )
}

export function signQaFixtureHeartbeat(sequence = 1, issuedAt = Date.now()): Buffer {
  const stamp = compiledQaPersistenceRunContext()
  if (!stamp) throw new Error('QA fixture stamp is missing')
  const unsigned = {
    schema: QA_HEARTBEAT_SCHEMA,
    runId: stamp.context.runId,
    runGeneration: 1,
    sequence,
    issuedAt
  }
  const signature = sign(
    null,
    Buffer.concat([heartbeatDomain, Buffer.from(qaPersistenceCanonical(unsigned), 'utf8')]),
    fixturePrivateKey
  )
  return Buffer.from(qaPersistenceCanonical({ ...unsigned, signature: signature.toString('base64url') }), 'utf8')
}

export function newQaFixtureChallenge(): string {
  return newQaPersistenceBootChallenge()
}

export async function buildQaRunOwnerChild(
  outputDirectory: string,
  compiledStamp = fixtureBuildStamp
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true })
  const outfile = join(outputDirectory, 'persistence-run-owner-child.cjs')
  await build({
    entryPoints: [sourceChild],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: {
      __METIS_QA_IDENTITY__: 'true',
      __METIS_QA_PERSISTENCE_BUILD_STAMP__: JSON.stringify(compiledStamp)
    },
    alias: {
      '@shared': resolve(__dirname, '../../../src/shared'),
      electron: sourceElectronHost
    },
    external: ['electron-log']
  })
  return outfile
}

export type QaRunOwnerChild = {
  readonly process: ChildProcess
  readonly receivedFrameCount: number
  reportCount(type: string): number
  sendFrame(bytes: Uint8Array): Promise<void>
  sendPartialFrameAndEnd(bytes: Uint8Array, sentBytes: number): Promise<void>
  endInput(): void
  closeOutput(): void
  sendInvalidFrameLength(length: number): Promise<void>
  readFrame(): Promise<Buffer>
  sendCommand(
    command:
      | 'check'
      | 'create-root'
      | 'registry-negative'
      | 'settle'
      | 'hide-check'
      | 'navigate-aba'
      | 'duplicate-prepare'
      | 'successor'
      | 'stale-owner'
      | 'create-root-held'
      | 'change-userdata-resume'
      | 'registry-cleanup'
      | 'hold-profile-preparation'
      | 'release-profile-preparation'
      | 'fail-profile-close'
      | 'release-failed-close'
      | 'create-root-physical-held'
      | 'retire-window-resume'
      | 'release-profile-physical-check'
  ): void
  retireWindowDuringPreparation(event: 'navigate' | 'replace' | 'close' | 'render-process-loss'): void
  waitForReport(type: string, timeoutMs?: number): Promise<Record<string, unknown>>
  terminate(): Promise<void>
}

export function startQaRunOwnerChild(entry: string, userDataPath: string, mode = 'shown'): QaRunOwnerChild {
  const child = spawn(process.execPath, [entry, userDataPath, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }
  })
  const reportQueue: Record<string, unknown>[] = []
  const reportWaiters: { type: string; resolve: (report: Record<string, unknown>) => void }[] = []
  const reportCounts = new Map<string, number>()
  child.on('message', (value) => {
    if (!value || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return
    const report = value as Record<string, unknown>
    reportCounts.set(report.type as string, (reportCounts.get(report.type as string) ?? 0) + 1)
    const index = reportWaiters.findIndex((waiter) => waiter.type === report.type)
    if (index >= 0) reportWaiters.splice(index, 1)[0].resolve(report)
    else reportQueue.push(report)
  })

  let frameBuffer = Buffer.alloc(0)
  const frameQueue: Buffer[] = []
  const frameWaiters: ((value: Buffer) => void)[] = []
  let receivedFrameCount = 0
  child.stdio[4]?.on('data', (chunk: Buffer) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk])
    if (frameBuffer.byteLength > 65_540) {
      child.kill()
      return
    }
    while (frameBuffer.byteLength >= 4) {
      const size = frameBuffer.readUInt32BE(0)
      if (size === 0 || size > 65_536) {
        child.kill()
        return
      }
      if (frameBuffer.byteLength < size + 4) return
      const message = frameBuffer.subarray(4, size + 4)
      frameBuffer = frameBuffer.subarray(size + 4)
      receivedFrameCount += 1
      const waiter = frameWaiters.shift()
      if (waiter) waiter(message)
      else frameQueue.push(message)
    }
  })

  return {
    process: child,
    get receivedFrameCount() {
      return receivedFrameCount
    },
    reportCount(type) {
      return reportCounts.get(type) ?? 0
    },
    sendFrame(bytes) {
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536)
        return Promise.reject(new Error('Fixture frame is outside bounds'))
      const frame = Buffer.allocUnsafe(bytes.byteLength + 4)
      frame.writeUInt32BE(bytes.byteLength, 0)
      Buffer.from(bytes).copy(frame, 4)
      return new Promise<void>((resolve, rejectWrite) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectWrite(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        input.write(frame, (error) => (error ? rejectWrite(error) : resolve()))
      })
    },
    sendPartialFrameAndEnd(bytes, sentBytes) {
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536 || sentBytes < 1 || sentBytes >= bytes.byteLength + 4)
        return Promise.reject(new Error('Fixture partial frame is outside bounds'))
      const frame = Buffer.allocUnsafe(bytes.byteLength + 4)
      frame.writeUInt32BE(bytes.byteLength, 0)
      Buffer.from(bytes).copy(frame, 4)
      return new Promise<void>((resolvePartial, rejectPartial) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectPartial(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        input.write(frame.subarray(0, sentBytes), (error) => {
          if (error) rejectPartial(error)
          else {
            input.end()
            resolvePartial()
          }
        })
      })
    },
    endInput() {
      const input = child.stdio[3] as NodeJS.WritableStream | null
      input?.end()
    },
    closeOutput() {
      child.stdio[4]?.destroy()
    },
    sendInvalidFrameLength(length) {
      const frame = Buffer.alloc(4)
      frame.writeUInt32BE(length, 0)
      return new Promise<void>((resolveInvalid, rejectInvalid) => {
        const input = child.stdio[3] as NodeJS.WritableStream | null
        if (!input) {
          rejectInvalid(new Error('QA fixture child input pipe is unavailable'))
          return
        }
        input.write(frame, (error) => (error ? rejectInvalid(error) : resolveInvalid()))
      })
    },
    readFrame() {
      const queued = frameQueue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise<Buffer>((resolveFrame) => frameWaiters.push(resolveFrame))
    },
    sendCommand(command) {
      child.send({ command })
    },
    retireWindowDuringPreparation(event) {
      child.send({ command: 'retire-during-preparation', event })
    },
    waitForReport(type, timeoutMs = 15_000) {
      const queuedIndex = reportQueue.findIndex((report) => report.type === type)
      if (queuedIndex >= 0) return Promise.resolve(reportQueue.splice(queuedIndex, 1)[0])
      return new Promise((resolveReport, rejectReport) => {
        const timer = setTimeout(() => rejectReport(new Error(`QA fixture did not report ${type}`)), timeoutMs)
        reportWaiters.push({
          type,
          resolve: (report) => {
            clearTimeout(timer)
            resolveReport(report)
          }
        })
      })
    },
    terminate() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
      return new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit())
        child.kill()
      })
    }
  }
}

export function parentPathForProfile(profile: PhysicalDirectoryIdentity): string {
  return dirname(profile.path)
}
