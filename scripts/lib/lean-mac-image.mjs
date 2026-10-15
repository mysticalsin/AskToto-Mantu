import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, stat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256File } from './lean-payload-attribution.mjs'

const SETTLEMENT_MS = 20_000
const INFO_TIMEOUT_MS = 2_000
const SETTLEMENT_INTERVAL_MS = 250
const SAFE_CASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** @typedef {{ command: string, args: string[], cwd: string | null, exitCode: number | null, signal: string | null, elapsedMs: number | null, timedOut: boolean, outputLimitExceeded: boolean, spawnError?: string, stdout: string, stderr: string }} MacCommandEvidence */
/** @typedef {{ command: string, args: string[], error: string } | MacCommandEvidence} MacRecordedCommand */
/** @typedef {{ status: 'pending' | 'settling' | 'complete', reason?: string, ownedAttachments: Array<{ imagePath: string }> | null, error?: string, child?: MacCommandEvidence | null, directoryRemoved?: boolean, directoryRetained?: boolean }} MacCleanupEvidence */
/** @typedef {{ bytes: number, sha256: string, allocatedBytes: number, unchangedThroughConversion?: boolean }} MacImageIdentityEvidence */
/** @typedef {{ caseId: string, volumeName: string, volumeNamePolicy: string, ownedDirectory: string, projectionPath: string, rawImagePath: string, outputImagePath: string, commands: MacRecordedCommand[], cleanup: MacCleanupEvidence, raw?: MacImageIdentityEvidence, output?: MacImageIdentityEvidence, failure?: { message: string, command: MacCommandEvidence | null } }} MacImageDiagnosticEvidence */

function bounded(value, maximum = 32_000) {
  return String(value ?? '').slice(0, maximum)
}

function commandRecord(result, isInfo = false) {
  return {
    command: bounded(result.command, 4096),
    args: Array.isArray(result.args) ? result.args.slice(0, 128).map((arg) => bounded(arg, 4096)) : [],
    cwd: result.cwd ? bounded(result.cwd, 4096) : null,
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    signal: result.signal === null || typeof result.signal === 'string' ? result.signal : null,
    elapsedMs: Number.isSafeInteger(result.elapsedMs) ? result.elapsedMs : null,
    timedOut: result.timedOut === true,
    outputLimitExceeded: result.outputLimitExceeded === true,
    ...(typeof result.spawnError === 'string' ? { spawnError: bounded(result.spawnError, 4000) } : {}),
    stdout: isInfo ? '[bounded hdiutil info plist parsed for owned-image identity]' : bounded(result.stdout, 4000),
    stderr: bounded(result.stderr, 4000)
  }
}

function exactOwnedAttachments(xml, plist, ownedPaths) {
  const parsed = plist.parse(xml)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.images))
    throw new Error('hdiutil info plist has an invalid images schema')
  const attachments = []
  for (const image of parsed.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image['image-path'] !== 'string')
      throw new Error('hdiutil info plist has an invalid image entry')
    if (image['system-entities'] !== undefined && !Array.isArray(image['system-entities']))
      throw new Error('hdiutil info plist has an invalid system-entities schema')
    const path = resolve(image['image-path'])
    if (ownedPaths.has(path)) attachments.push({ imagePath: path })
  }
  return attachments
}

/**
 * Own a diagnostic DMG's complete lifecycle and retain its directory if ownership is uncertain.
 * @returns {Promise<MacImageDiagnosticEvidence>}
 */
export async function withOwnedMacImage({
  payloadRoot,
  scratchRoot,
  caseId,
  prepareProjection,
  run,
  redact = (value) => value,
  timeouts = {},
  fsApi = { mkdtemp, mkdir, rm, stat, realpath },
  randomBytesImpl = randomBytes,
  now = () => Date.now(),
  delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}) {
  if (!SAFE_CASE_ID.test(caseId)) throw new Error(`Invalid bounded Mac diagnostic case ID: ${caseId}`)
  const scratchParent = await fsApi.realpath(resolve(scratchRoot))
  const ownedDir = await fsApi.mkdtemp(join(scratchParent, `lean-mac-${caseId}-`))
  const canonicalOwnedDir = await fsApi.realpath(ownedDir)
  const projectionRoot = join(canonicalOwnedDir, 'source')
  const rawImage = join(canonicalOwnedDir, 'raw.dmg')
  const image = join(canonicalOwnedDir, 'converted.dmg')
  const volumeName = `METIS_A_${randomBytesImpl(12).toString('hex')}`
  const ownedPaths = new Set([resolve(rawImage), resolve(image)])
  const require = createRequire(join(resolve(payloadRoot), 'package.json'))
  const plist = require('plist')
  const commands = []
  /** @type {MacImageDiagnosticEvidence} */
  const evidence = {
    caseId,
    volumeName,
    volumeNamePolicy: 'METIS_A_ plus 24 random lowercase hexadecimal characters; fixed 32 ASCII bytes',
    ownedDirectory: canonicalOwnedDir,
    projectionPath: projectionRoot,
    rawImagePath: rawImage,
    outputImagePath: image,
    commands,
    cleanup: { status: 'pending', ownedAttachments: null }
  }
  let originalError = null
  let allChildrenClosed = true
  let cleanupError = null
  let cleanupSettled = false
  let settlementFailed = false
  let removeDirectory = false

  const invoke = async (command, args, options = {}) => {
    try {
      const result = await run(command, args, options)
      commands.push(commandRecord(result, args[0] === 'info'))
      return result
    } catch (error) {
      if (error?.result) commands.push(commandRecord(error.result, args[0] === 'info'))
      else commands.push({ command, args: [...args], error: bounded(error?.message ?? error) })
      // The injected runner contract settles only after close. Unknown runner failures do not.
      if (!error?.result) allChildrenClosed = false
      throw error
    }
  }

  const snapshot = async (timeoutMs) => {
    const result = await invoke('hdiutil', ['info', '-plist'], { timeoutMs, maxOutputBytes: 1_000_000 })
    return exactOwnedAttachments(result.stdout, plist, ownedPaths)
  }

  const settle = async (reason) => {
    const started = now()
    let clearSnapshots = 0
    let lastAttachments = null
    while (now() - started < SETTLEMENT_MS) {
      const remaining = SETTLEMENT_MS - (now() - started)
      const infoTimeout = Math.max(1, Math.min(INFO_TIMEOUT_MS, remaining))
      try {
        lastAttachments = await snapshot(infoTimeout)
      } catch (error) {
        evidence.cleanup = {
          status: 'pending',
          reason,
          ownedAttachments: lastAttachments,
          error: bounded(error?.message ?? error),
          child: error?.result ? commandRecord(error.result, true) : null
        }
        settlementFailed = true
        return false
      }
      if (lastAttachments.length) {
        clearSnapshots = 0
        evidence.cleanup = { status: 'pending', reason, ownedAttachments: lastAttachments }
      } else {
        clearSnapshots += 1
        evidence.cleanup = { status: 'settling', reason, ownedAttachments: [] }
        if (clearSnapshots >= 2) {
          evidence.cleanup = { status: 'complete', reason, ownedAttachments: [] }
          return true
        }
      }
      if (now() - started >= SETTLEMENT_MS) break
      await delay(Math.min(SETTLEMENT_INTERVAL_MS, Math.max(0, SETTLEMENT_MS - (now() - started))))
    }
    evidence.cleanup = { status: 'pending', reason, ownedAttachments: lastAttachments }
    settlementFailed = true
    return false
  }

  try {
    await fsApi.mkdir(projectionRoot, { recursive: false })
    await prepareProjection(projectionRoot)
    await invoke(
      'hdiutil',
      [
        'create',
        '-ov',
        '-fs',
        'HFS+',
        '-volname',
        volumeName,
        '-srcfolder',
        projectionRoot,
        '-format',
        'UDRW',
        rawImage
      ],
      {
        timeoutMs: timeouts.createMs ?? 60 * 60_000
      }
    )
    if (!(await settle('after-create')))
      throw new Error(`Owned image attachment did not settle after create: ${caseId}`)
    const rawIdentity = await sha256File(rawImage)
    const rawStat = await fsApi.stat(rawImage, { bigint: true })
    evidence.raw = { ...rawIdentity, allocatedBytes: Number(rawStat.blocks * 512n) }

    await invoke('hdiutil', ['convert', rawImage, '-format', 'UDBZ', '-o', image], {
      timeoutMs: timeouts.convertMs ?? 60 * 60_000
    })
    if (!(await settle('after-convert')))
      throw new Error(`Owned image attachment did not settle after convert: ${caseId}`)
    const rawAfterConvert = await sha256File(rawImage)
    evidence.raw.unchangedThroughConversion =
      rawIdentity.bytes === rawAfterConvert.bytes && rawIdentity.sha256 === rawAfterConvert.sha256
    if (!evidence.raw.unchangedThroughConversion) throw new Error(`UDRW source changed during conversion: ${caseId}`)

    await invoke('hdiutil', ['verify', image], { timeoutMs: timeouts.verifyMs ?? 10 * 60_000 })
    const outputIdentity = await sha256File(image)
    const outputStat = await fsApi.stat(image, { bigint: true })
    evidence.output = { ...outputIdentity, allocatedBytes: Number(outputStat.blocks * 512n) }
    if (!(await settle('final'))) throw new Error(`Owned image attachment did not settle after verify: ${caseId}`)
    cleanupSettled = true
  } catch (error) {
    originalError = error
    evidence.failure = {
      message: bounded(error?.message ?? error, 4000),
      command: error?.result ? commandRecord(error.result) : null
    }
  } finally {
    if (allChildrenClosed && !cleanupSettled && !settlementFailed) cleanupSettled = await settle('cleanup')
    if (!allChildrenClosed) {
      evidence.cleanup = { status: 'pending', reason: 'child-close-not-confirmed', ownedAttachments: null }
    }
    if (allChildrenClosed && cleanupSettled) {
      try {
        await fsApi.rm(canonicalOwnedDir, { recursive: true, force: false })
        removeDirectory = true
        evidence.cleanup = { ...evidence.cleanup, status: 'complete', directoryRemoved: true }
      } catch (error) {
        cleanupError = error
        evidence.cleanup = {
          ...evidence.cleanup,
          status: 'pending',
          directoryRemoved: false,
          error: bounded(error?.message ?? error)
        }
      }
    }
    evidence.cleanup.directoryRetained = !removeDirectory
  }

  if (originalError) {
    const error = Object.assign(new Error(bounded(originalError.message ?? originalError, 4000)), {
      result: originalError.result,
      evidence,
      cleanupError: cleanupError ? bounded(cleanupError.message ?? cleanupError) : null
    })
    throw error
  }
  if (cleanupError) {
    throw Object.assign(new Error(`Owned image cleanup failed for ${caseId}`), {
      evidence,
      cleanupError: bounded(cleanupError.message ?? cleanupError)
    })
  }
  return evidence
}
