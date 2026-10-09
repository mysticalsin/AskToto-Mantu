#!/usr/bin/env node
// Publish already-qualified bytes, never rebuild or bypass candidate evidence. Both destinations are
// prereleases for manual installation. The source tag deliberately cannot trigger release.yml's v*.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import { Transform, pipeline } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { uploadProblems } from './provenance.mjs'

const REPOSITORIES = Object.freeze(['mysticalsin/AskToto-Mantu', 'mysticalsin/Metis-Releases'])
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const RUN_ID = /^[1-9][0-9]{0,19}$/
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const MAX_JSON = 2 * 1024 * 1024
const MAX_PAGES = 100

/** @typedef {{name: string, size: number, sha256: string}} Asset */
/** @typedef {{repository: string, route: string, method?: string,
 * json?: Record<string, unknown>, asset?: Asset}} ApiCall */
/** @typedef {{status: number, data: unknown}} ApiResponse */
/** @typedef {{repository: string, tag: string, target_commit: string | null,
 * release_id: number | null, state: string}} TargetReceipt */
/** @typedef {{schema_version: number, candidate_run_id: string, candidate_commit: string,
 * manifest_sha256: string, promotion_run_id: string, promotion_attempt: string, publish_requested: boolean,
 * publication_attempted: boolean, receipt_persistence_failed: boolean, phase: string, outcome: string,
 * failure: {phase: string, code: string} | null, cleanup_errors: {repository: string, code: string}[],
 * targets: TargetReceipt[]}} PromotionReceipt */
/** @typedef {{version: string, candidateRun: string, candidateCommit: string, promotionRun: string,
 * promotionAttempt: string, publish: boolean, manifest: Asset[], manifestSha256: string,
 * notes: string}} PromotionInput */

class PromotionFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

/** @returns {never} */
const fail = (code) => {
  throw new PromotionFailure(code)
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = (value) => Number.isSafeInteger(value) && value > 0
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const codeOf = (error) => (error instanceof PromotionFailure ? error.code : 'operation-failed')

function validManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > 1000) return false
  const names = new Set()
  for (const asset of manifest) {
    if (
      !object(asset) ||
      Object.keys(asset).sort().join(',') !== 'name,sha256,size' ||
      typeof asset.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(asset.name) ||
      /^latest.*\.ya?ml$/i.test(asset.name) ||
      /\.blockmap$/i.test(asset.name) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      typeof asset.sha256 !== 'string' ||
      !SHA256.test(asset.sha256) ||
      names.has(asset.name)
    ) {
      return false
    }
    names.add(asset.name)
  }
  return true
}

async function regularFile(path, expectedSize, limit) {
  if (!(await lstat(path)).isFile()) fail('stage-invalid')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (expectedSize !== undefined && stat.size !== expectedSize) || stat.size > limit) {
      fail('stage-invalid')
    }
    return file
  } catch (error) {
    await file.close()
    throw error
  }
}

async function boundedFile(path, limit) {
  const file = await regularFile(path, undefined, limit)
  try {
    const chunks = []
    let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length
      if (size > limit) fail('stage-invalid')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } finally {
    await file.close()
  }
}

/** No glob, symlink or whole-installer buffering. These are prepare-release's exact staged bytes.
 * @returns {Promise<{manifest: Asset[], manifestSha256: string, notes: string}>}
 */
export async function readStage(directory) {
  try {
    const bytes = await boundedFile(join(directory, 'manifest.json'), MAX_JSON)
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (!validManifest(manifest)) fail('stage-invalid')
    const notes = (await boundedFile(join(directory, 'notes.md'), MAX_JSON)).toString('utf8')
    if (!notes.trim()) fail('stage-invalid')
    for (const asset of manifest) {
      const file = await regularFile(join(directory, 'upload', asset.name), asset.size, Number.MAX_SAFE_INTEGER)
      try {
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length
          hash.update(chunk)
        }
        if (size !== asset.size || hash.digest('hex') !== asset.sha256) fail('stage-invalid')
      } finally {
        await file.close()
      }
    }
    return { manifest, manifestSha256: sha256(bytes), notes }
  } catch {
    fail('stage-invalid')
  }
}

/** Exclusive temporary creation and atomic rename preserve the last complete cumulative receipt. */
export async function persistReceipt(path, receipt) {
  const temporary = `${path}.pending`
  let file
  let owned = false
  try {
    file = await open(temporary, 'wx', 0o600)
    owned = true
    await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, path)
  } catch {
    await file?.close().catch(() => {})
    // Remove only the temporary file opened by this invocation, never a pre-existing collision.
    if (owned) await unlink(temporary).catch(() => {})
    fail('receipt-write-failed')
  }
}

/** Small injected state machine. Tests use only synthetic transport; the CLI owns real HTTP.
 * @param {PromotionInput} input
 * @param {{request: (call: ApiCall) => Promise<ApiResponse>,
 * persist: (receipt: PromotionReceipt) => Promise<void>}} dependencies
 * @returns {Promise<{ok: boolean, code?: string, receipt?: PromotionReceipt, urls: string[]}>}
 */
export async function publishDualRelease(input, { request, persist }) {
  if (
    !object(input) ||
    typeof input.version !== 'string' ||
    !VERSION.test(input.version) ||
    input.version.length > 100 ||
    ![input.candidateRun, input.promotionRun, input.promotionAttempt].every(
      (value) => typeof value === 'string' && RUN_ID.test(value)
    ) ||
    typeof input.candidateCommit !== 'string' ||
    !COMMIT.test(input.candidateCommit) ||
    typeof input.publish !== 'boolean' ||
    !validManifest(input.manifest) ||
    typeof input.manifestSha256 !== 'string' ||
    !SHA256.test(input.manifestSha256) ||
    typeof input.notes !== 'string' ||
    !input.notes.trim() ||
    Buffer.byteLength(input.notes) > MAX_JSON
  ) {
    return { ok: false, code: 'input-invalid', urls: [] }
  }

  const suffix = input.publish ? '' : `.dryrun.${input.candidateRun}.${input.promotionRun}.${input.promotionAttempt}`
  const title = `Métis ${input.version} (unsigned, manual install)`
  const receipt = {
    schema_version: 1,
    candidate_run_id: input.candidateRun,
    candidate_commit: input.candidateCommit,
    manifest_sha256: input.manifestSha256,
    promotion_run_id: input.promotionRun,
    promotion_attempt: input.promotionAttempt,
    publish_requested: input.publish,
    publication_attempted: false,
    receipt_persistence_failed: false,
    phase: 'preflight',
    outcome: 'pending',
    failure: null,
    cleanup_errors: [],
    targets: REPOSITORIES.map((repository, index) => ({
      repository,
      tag: `${index === 0 ? 'metis-unsigned-v' : 'v'}${input.version}${suffix}`,
      target_commit: null,
      release_id: null,
      state: 'planned'
    }))
  }

  async function save() {
    try {
      await persist(structuredClone(receipt))
    } catch {
      receipt.receipt_persistence_failed = true
      fail('receipt-write-failed')
    }
  }

  async function api(target, route, options = {}) {
    const { status = 200, absent = false, ...call } = options
    let response
    try {
      response = await request({ repository: target.repository, route, ...call })
    } catch {
      fail('api-transport')
    }
    if (!object(response)) fail('api-response')
    if (absent && response.status === 404) return null
    if (response.status !== status) fail('api-status')
    return response.data
  }

  async function list(target, route, kind) {
    const result = []
    const ids = new Set()
    const names = new Set()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const entries = await api(target, `${route}?per_page=100&page=${page}`)
      if (!Array.isArray(entries) || entries.length > 100) fail('list-shape')
      for (const entry of entries) {
        if (!object(entry) || !positiveId(entry.id) || ids.has(entry.id)) fail('list-identity')
        const name = kind === 'assets' ? entry.name : entry.tag_name
        if (typeof name !== 'string' || !name || names.has(name)) fail('list-identity')
        if (kind === 'releases' && (typeof entry.draft !== 'boolean' || typeof entry.prerelease !== 'boolean')) {
          fail('list-shape')
        }
        ids.add(entry.id)
        names.add(name)
        result.push(entry)
      }
      // Do not infer exhaustion from a short page; require the following page to be empty.
      if (entries.length === 0) return result
    }
    fail('list-limit')
  }

  async function latest(target) {
    const release = await api(target, 'releases/latest')
    if (
      !object(release) ||
      !positiveId(release.id) ||
      typeof release.tag_name !== 'string' ||
      !release.tag_name ||
      release.draft !== false ||
      release.prerelease !== false ||
      release.id === target.release_id ||
      release.tag_name === target.tag
    ) {
      fail('latest-identity')
    }
  }

  async function tag(target, allowAbsent) {
    const ref = await api(target, `git/ref/tags/${encodeURIComponent(target.tag)}`, { absent: allowAbsent })
    if (ref === null && allowAbsent) return false
    if (
      !object(ref) ||
      ref.ref !== `refs/tags/${target.tag}` ||
      !object(ref.object) ||
      typeof ref.object.sha !== 'string' ||
      !COMMIT.test(ref.object.sha) ||
      !['commit', 'tag'].includes(ref.object.type)
    ) {
      fail('tag-identity')
    }
    return true
  }

  async function verifyTag(target, allowAbsent) {
    if (!(await tag(target, allowAbsent))) return
    const commit = await api(target, `commits/${encodeURIComponent(`refs/tags/${target.tag}`)}`)
    if (!object(commit) || commit.sha !== target.target_commit) fail('tag-target')
  }

  function identity(release, target, draft) {
    if (
      !object(release) ||
      !positiveId(release.id) ||
      (target.release_id !== null && release.id !== target.release_id) ||
      release.tag_name !== target.tag ||
      release.draft !== draft ||
      release.prerelease !== true ||
      release.name !== title ||
      release.body !== input.notes ||
      release.target_commitish !== target.target_commit
    ) {
      fail('release-identity')
    }
  }

  async function verifyAssets(target) {
    const assets = await list(target, `releases/${target.release_id}/assets`, 'assets')
    if (uploadProblems(input.manifest, assets).length !== 0) fail('asset-mismatch')
  }

  async function cleanup() {
    receipt.phase = 'cleanup'
    for (const target of receipt.targets) {
      if (receipt.receipt_persistence_failed || receipt.publication_attempted) break
      if (target.release_id === null || target.state === 'deleted') continue
      try {
        identity(await api(target, `releases/${target.release_id}`), target, true)
        target.state = 'cleanup-attempted'
        await save()
        await api(target, `releases/${target.release_id}`, { method: 'DELETE', status: 204 })
        target.state = 'deleted'
        await save()
      } catch (error) {
        if (target.state !== 'deleted') target.state = 'unknown'
        receipt.cleanup_errors.push({ repository: target.repository, code: codeOf(error) })
      }
    }
  }

  try {
    // A public GET/404 alone cannot establish draft visibility. Require the publishing credential's
    // push visibility on both exact repositories, then check absence. Create still proves write scope.
    for (const target of receipt.targets) {
      const repo = await api(target, '')
      if (
        !object(repo) ||
        repo.full_name !== target.repository ||
        repo.permissions?.push !== true ||
        typeof repo.default_branch !== 'string' ||
        !repo.default_branch ||
        repo.default_branch.length > 200
      ) {
        fail('repository-identity')
      }
      const ref = target.repository === REPOSITORIES[0] ? input.candidateCommit : repo.default_branch
      const commit = await api(target, `commits/${encodeURIComponent(ref)}`)
      if (!object(commit) || typeof commit.sha !== 'string' || !COMMIT.test(commit.sha)) fail('commit-identity')
      if (target.repository === REPOSITORIES[0] && commit.sha !== input.candidateCommit) fail('commit-identity')
      target.target_commit = commit.sha
      await latest(target)
    }
    for (const target of receipt.targets) {
      if ((await list(target, 'releases', 'releases')).some((release) => release.tag_name === target.tag)) {
        fail('release-exists')
      }
      if (await tag(target, true)) fail('tag-exists')
    }
    await save()

    receipt.phase = 'create'
    for (const target of receipt.targets) {
      target.state = 'create-attempted'
      await save()
      const created = await api(target, 'releases', {
        method: 'POST',
        status: 201,
        json: {
          tag_name: target.tag,
          target_commitish: target.target_commit,
          name: title,
          body: input.notes,
          draft: true,
          prerelease: true,
          make_latest: 'false'
        }
      })
      identity(created, target, true)
      target.release_id = created.id
      target.state = 'draft'
      await save()
    }

    receipt.phase = 'upload'
    for (const target of receipt.targets) {
      for (const asset of input.manifest) {
        await api(target, `releases/${target.release_id}/assets?name=${encodeURIComponent(asset.name)}`, {
          method: 'POST',
          status: 201,
          asset
        })
      }
      target.state = 'uploaded'
      await save()
      await verifyAssets(target)
      target.state = 'verified'
      await save()
    }

    receipt.phase = 'verify'
    for (const target of receipt.targets) {
      identity(await api(target, `releases/${target.release_id}`), target, true)
      await verifyAssets(target)
      await verifyTag(target, true)
    }

    if (!input.publish) {
      await cleanup()
      if (receipt.receipt_persistence_failed) fail('receipt-write-failed')
      if (receipt.cleanup_errors.length) fail('cleanup-failed')
      receipt.outcome = 'dry-run'
    } else {
      receipt.phase = 'publish'
      // This marker precedes even the first PATCH. A lost response must never allow draft cleanup.
      receipt.publication_attempted = true
      await save()
      for (const target of receipt.targets) {
        target.state = 'publish-attempted'
        await save()
        const published = await api(target, `releases/${target.release_id}`, {
          method: 'PATCH',
          json: { draft: false, prerelease: true, make_latest: 'false' }
        })
        identity(published, target, false)
        target.state = 'published'
        await save()
      }
      receipt.phase = 'readback'
      for (const target of receipt.targets) {
        identity(await api(target, `releases/${target.release_id}`), target, false)
        await verifyAssets(target)
        await verifyTag(target, false)
        await latest(target)
      }
      receipt.outcome = 'published'
    }
    receipt.phase = 'complete'
    await save()
    return {
      ok: true,
      receipt,
      urls: input.publish
        ? receipt.targets.map((target) => `https://github.com/${target.repository}/releases/tag/${target.tag}`)
        : []
    }
  } catch (error) {
    receipt.failure = { phase: receipt.phase, code: codeOf(error) }
    receipt.outcome = receipt.publication_attempted ? 'partial-or-unknown' : 'failed'
    for (const target of receipt.targets) {
      if (target.state === 'create-attempted' || target.state === 'publish-attempted') target.state = 'unknown'
    }
    if (!receipt.publication_attempted && !receipt.receipt_persistence_failed && receipt.phase !== 'cleanup') {
      await cleanup()
    }
    if (!receipt.receipt_persistence_failed) {
      try {
        await save()
      } catch {
        // Preserve the original error; the in-memory result also records receipt persistence failure.
      }
    }
    return { ok: false, code: receipt.failure.code, receipt, urls: [] }
  }
}

/** HTTPS only; construct endpoints locally, refuse redirects, cap JSON, stream uploads and never retry.
 * @param {{token: string | undefined, stageDir: string, requestImpl?: typeof httpsRequest}} options
 * @returns {(call: ApiCall) => Promise<ApiResponse>}
 */
export function createGitHubTransport({ token, stageDir, requestImpl = httpsRequest }) {
  return async ({ repository, route, method = 'GET', json, asset }) => {
    if (
      !REPOSITORIES.includes(repository) ||
      typeof route !== 'string' ||
      !/^[A-Za-z0-9%_/?=&.-]*$/.test(route) ||
      route.startsWith('/') ||
      route.includes('..') ||
      !['GET', 'POST', 'PATCH', 'DELETE'].includes(method) ||
      typeof token !== 'string' ||
      !token ||
      /[\r\n]/.test(token) ||
      (asset && (!validManifest([asset]) || method !== 'POST' || json !== undefined))
    ) {
      fail('transport-input')
    }
    const host = asset ? 'uploads.github.com' : 'api.github.com'
    const url = new URL(`https://${host}/repos/${repository}${route ? `/${route}` : ''}`)
    const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json))
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'metis-candidate-promotion',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}),
      ...(asset ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) } : {})
    }
    let file
    try {
      if (asset) file = await regularFile(join(stageDir, 'upload', asset.name), asset.size, Number.MAX_SAFE_INTEGER)
      return await new Promise((resolve, reject) => {
        let settled = false
        let req
        let response
        let source
        let verifier
        let transferComplete = !file
        let responseResult
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) {
            source?.destroy()
            verifier?.destroy()
            response?.destroy()
            req?.destroy()
            reject(error instanceof PromotionFailure ? error : new PromotionFailure('http-transport'))
          } else {
            resolve(value)
          }
        }
        const complete = () => {
          if (transferComplete && responseResult) finish(null, responseResult)
        }
        const timer = setTimeout(() => finish(new PromotionFailure('http-deadline')), asset ? 1_200_000 : 60_000)
        try {
          req = requestImpl(url, { method, headers }, (res) => {
            response = res
            if (res.statusCode >= 300 && res.statusCode < 400) {
              finish(new PromotionFailure('http-redirect'))
              return
            }
            const chunks = []
            let length = 0
            res.on('error', (error) => finish(error))
            res.on('aborted', () => finish(new PromotionFailure('http-transport')))
            res.on('data', (chunk) => {
              length += chunk.length
              if (length > MAX_JSON) finish(new PromotionFailure('http-response-limit'))
              else chunks.push(Buffer.from(chunk))
            })
            res.on('end', () => {
              if (settled) return
              try {
                const bytes = Buffer.concat(chunks)
                responseResult = {
                  status: res.statusCode,
                  data: bytes.length ? JSON.parse(bytes.toString('utf8')) : null
                }
                complete()
              } catch {
                finish(new PromotionFailure('http-json'))
              }
            })
          })
          req.on('error', (error) => finish(error))
          if (file) {
            const hash = createHash('sha256')
            let size = 0
            source = file.createReadStream({ autoClose: false })
            verifier = new Transform({
              transform(chunk, _encoding, callback) {
                size += chunk.length
                hash.update(chunk)
                callback(size > asset.size ? new PromotionFailure('asset-bytes-changed') : null, chunk)
              },
              flush(callback) {
                callback(
                  size !== asset.size || hash.digest('hex') !== asset.sha256
                    ? new PromotionFailure('asset-bytes-changed')
                    : null
                )
              }
            })
            pipeline(source, verifier, req, (error) => {
              if (error) finish(error)
              else {
                transferComplete = true
                complete()
              }
            })
          } else {
            req.end(body)
          }
        } catch (error) {
          finish(error)
        }
      })
    } catch (error) {
      throw error instanceof PromotionFailure ? error : new PromotionFailure('http-transport')
    } finally {
      await file?.close()
    }
  }
}

async function main() {
  const env = process.env
  const directory = env.PROMOTION_DIRECTORY
  const receiptPath = env.PROMOTION_RECEIPT
  if (!directory || !receiptPath || !['true', 'false'].includes(env.PUBLISH)) fail('cli-input')
  const result = await publishDualRelease(
    {
      ...(await readStage(directory)),
      version: env.VERSION,
      candidateRun: env.CANDIDATE_RUN,
      candidateCommit: env.CANDIDATE_COMMIT,
      promotionRun: env.GITHUB_RUN_ID,
      promotionAttempt: env.GITHUB_RUN_ATTEMPT,
      publish: env.PUBLISH === 'true'
    },
    {
      request: createGitHubTransport({ token: env.GH_TOKEN, stageDir: directory }),
      persist: (receipt) => persistReceipt(receiptPath, receipt)
    }
  )
  if (!result.ok) {
    console.error(`Promotion failed: ${result.code}; inspect the closed promotion receipt.`)
    process.exitCode = 1
    return
  }
  console.log(
    result.urls.length
      ? `Both prereleases verified:\n${result.urls.join('\n')}`
      : 'Both dry-run drafts verified and deleted.'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Promotion failed: ${codeOf(error)}.`)
    process.exitCode = 1
  })
}
