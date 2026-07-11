import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, promises as fs, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SCHEMA_VERSION = 1
const TARGET_PLATFORMS = ['darwin-arm64', 'win32-x64']
const ASSET_PLATFORMS = [...TARGET_PLATFORMS, 'all']
const APPROVALS = ['evaluation', 'release']
const NOTICE_KINDS = ['provenance', 'release-exception']
const PROVENANCE_STATUSES = ['complete', 'review-required']

const MODEL_RULES = {
  'qwen3-1.7b': { role: 'text', runtime: 'node-llama-cpp' },
  'qwen3-0.6b': { role: 'text', runtime: 'node-llama-cpp' },
  'smolvlm-256m-instruct': { role: 'vision', runtime: 'transformers.js' },
  'florence-2-base-ft': { role: 'vision', runtime: 'transformers.js' }
}

const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'COM¹',
  'COM²',
  'COM³',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'LPT¹',
  'LPT²',
  'LPT³'
])

const PLACEHOLDER = /(?:^|[-_.\s])(todo|tbd|placeholder|unknown|example)(?:$|[-_.\s])/i

function fail(message) {
  throw new Error(`local-ai-manifest: ${message}`)
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`)
}

function assertKeys(value, allowedKeys, label) {
  assertObject(value, label)
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown key "${key}"`)
  }
}

function assertString(value, label, maxLength = 500) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
}

function assertConcreteString(value, label, maxLength = 500) {
  assertString(value, label, maxLength)
  if (PLACEHOLDER.test(value) || ['main', 'master', 'head', 'latest'].includes(value.toLowerCase())) {
    fail(`${label} must not be a placeholder or moving reference`)
  }
}

function assertId(value, label) {
  assertString(value, label, 128)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    fail(`${label} must be a lowercase stable identifier`)
  }
}

function assertArray(value, label, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength) {
    fail(`${label} must be an array with at most ${maxLength} entries`)
  }
}

function assertUniqueIds(records, label) {
  const seen = new Set()
  for (const record of records) {
    if (seen.has(record.id)) fail(`${label} contains duplicate id "${record.id}"`)
    seen.add(record.id)
  }
}

function assertUniqueStrings(value, label, { allowEmpty = false, maxLength = 256 } = {}) {
  assertArray(value, label, maxLength)
  if (!allowEmpty && value.length === 0) fail(`${label} must not be empty`)
  const seen = new Set()
  for (const item of value) {
    assertId(item, `${label} entry`)
    if (seen.has(item)) fail(`${label} contains duplicate entry "${item}"`)
    seen.add(item)
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`)
}

function assertCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value) || /^0{40}$/.test(value)) {
    fail(`${label} must be a nonzero lowercase 40-hex commit`)
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value) || /^0{64}$/.test(value)) {
    fail(`${label} must be a nonzero lowercase 64-hex SHA-256`)
  }
}

function assertRepo(value, label) {
  assertConcreteString(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    fail(`${label} must be a Hugging Face owner/repo identifier`)
  }
}

function assertSafeRelativePath(value, label) {
  assertString(value, label, 500)
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /[:*<>|"]/u.test(value)
  ) {
    fail(`${label} must be a safe POSIX relative path`)
  }

  const segments = value.split('/')
  for (const segment of segments) {
    const windowsBase = segment.split('.')[0].toUpperCase()
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_RESERVED.has(windowsBase)
    ) {
      fail(`${label} must be a safe POSIX relative path`)
    }
  }
}

function assertPlatforms(value, label) {
  assertArray(value, label, ASSET_PLATFORMS.length)
  if (value.length === 0) fail(`${label} must not be empty`)
  const seen = new Set()
  for (const platform of value) {
    if (!ASSET_PLATFORMS.includes(platform)) fail(`${label} contains unknown platform "${platform}"`)
    if (seen.has(platform)) fail(`${label} contains duplicate platform "${platform}"`)
    seen.add(platform)
  }
  if (seen.has('all') && seen.size !== 1) fail(`${label} cannot mix "all" with a target platform`)
}

function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function compareDestination(a, b) {
  if (a.destination < b.destination) return -1
  if (a.destination > b.destination) return 1
  return 0
}

function validateLicense(record, index) {
  const label = `licenses[${index}]`
  assertKeys(record, ['id', 'path', 'bytes', 'sha256'], label)
  assertId(record.id, `${label}.id`)
  assertSafeRelativePath(record.path, `${label}.path`)
  if (!record.path.startsWith('resources/local-ai/licenses/')) {
    fail(`${label}.path must stay under resources/local-ai/licenses`)
  }
  assertPositiveSafeInteger(record.bytes, `${label}.bytes`)
  assertSha256(record.sha256, `${label}.sha256`)
}

function validateNotice(record, index) {
  const label = `notices[${index}]`
  assertKeys(record, ['id', 'kind', 'path', 'bytes', 'sha256'], label)
  assertId(record.id, `${label}.id`)
  if (!NOTICE_KINDS.includes(record.kind)) fail(`${label}.kind is invalid`)
  assertSafeRelativePath(record.path, `${label}.path`)
  if (!record.path.startsWith('resources/local-ai/licenses/')) {
    fail(`${label}.path must stay under resources/local-ai/licenses`)
  }
  assertPositiveSafeInteger(record.bytes, `${label}.bytes`)
  assertSha256(record.sha256, `${label}.sha256`)
}

function validateVariant(variant, index, noticeById) {
  const label = `variants[${index}]`
  assertKeys(
    variant,
    ['id', 'role', 'model', 'precision', 'runtime', 'componentIds', 'provenance'],
    label
  )
  assertId(variant.id, `${label}.id`)
  const rule = MODEL_RULES[variant.model]
  if (!rule) fail(`${label}.model is unsupported`)
  if (variant.role !== rule.role) fail(`${label}.role does not match ${variant.model}`)
  if (variant.runtime !== rule.runtime) fail(`${label}.runtime does not match ${variant.model}`)
  assertConcreteString(variant.precision, `${label}.precision`, 64)
  assertUniqueStrings(variant.componentIds, `${label}.componentIds`)
  assertKeys(variant.provenance, ['status', 'noticeIds'], `${label}.provenance`)
  if (!PROVENANCE_STATUSES.includes(variant.provenance.status)) {
    fail(`${label}.provenance.status is invalid`)
  }
  assertUniqueStrings(variant.provenance.noticeIds, `${label}.provenance.noticeIds`, {
    allowEmpty: variant.provenance.status === 'complete',
    maxLength: 32
  })
  for (const noticeId of variant.provenance.noticeIds) {
    if (!noticeById.has(noticeId)) fail(`${label} references unknown notice "${noticeId}"`)
  }
  if (
    variant.provenance.status === 'review-required' &&
    !variant.provenance.noticeIds.some((noticeId) => noticeById.get(noticeId)?.kind === 'provenance')
  ) {
    fail(`${label} review-required provenance needs a provenance notice`)
  }
}

function validateAsset(asset, index, variantById, licenseById) {
  const label = `assets[${index}]`
  assertKeys(
    asset,
    ['id', 'variantId', 'component', 'source', 'conversion', 'destination', 'platforms'],
    label
  )
  assertId(asset.id, `${label}.id`)
  assertId(asset.variantId, `${label}.variantId`)
  if (!variantById.has(asset.variantId)) fail(`${label} references unknown variant "${asset.variantId}"`)
  assertId(asset.component, `${label}.component`)

  assertKeys(asset.source, ['repo', 'commit', 'path', 'bytes', 'sha256', 'licenseId'], `${label}.source`)
  assertRepo(asset.source.repo, `${label}.source.repo`)
  assertCommit(asset.source.commit, `${label}.source.commit`)
  assertSafeRelativePath(asset.source.path, `${label}.source.path`)
  assertPositiveSafeInteger(asset.source.bytes, `${label}.source.bytes`)
  assertSha256(asset.source.sha256, `${label}.source.sha256`)
  assertId(asset.source.licenseId, `${label}.source.licenseId`)
  if (!licenseById.has(asset.source.licenseId)) {
    fail(`${label} references unknown source license "${asset.source.licenseId}"`)
  }

  if (asset.conversion !== undefined) {
    assertKeys(asset.conversion, ['tool', 'version', 'commit', 'recipe', 'licenseId'], `${label}.conversion`)
    assertConcreteString(asset.conversion.tool, `${label}.conversion.tool`, 128)
    assertConcreteString(asset.conversion.version, `${label}.conversion.version`, 128)
    assertCommit(asset.conversion.commit, `${label}.conversion.commit`)
    assertConcreteString(asset.conversion.recipe, `${label}.conversion.recipe`, 2000)
    assertId(asset.conversion.licenseId, `${label}.conversion.licenseId`)
    if (!licenseById.has(asset.conversion.licenseId)) {
      fail(`${label} references unknown conversion license "${asset.conversion.licenseId}"`)
    }
  }

  assertSafeRelativePath(asset.destination, `${label}.destination`)
  if (
    asset.destination === 'manifest.json' ||
    asset.destination.split('/').some((segment) => segment.toLowerCase().endsWith('.part'))
  ) {
    fail(`${label}.destination is reserved for supply-chain control files`)
  }
  assertPlatforms(asset.platforms, `${label}.platforms`)
}

function assertCaseFoldUnique(values, label) {
  const seen = new Map()
  for (const value of values) {
    const folded = value.normalize('NFKC').toLocaleLowerCase('en-US')
    if (seen.has(folded)) fail(`${label} collision between "${seen.get(folded)}" and "${value}"`)
    seen.set(folded, value)
  }
}

export function validateCatalog(catalog) {
  assertKeys(catalog, ['schemaVersion', 'selected', 'variants', 'assets', 'licenses', 'notices'], 'catalog')
  if (catalog.schemaVersion !== SCHEMA_VERSION) fail('catalog.schemaVersion must be 1')

  assertArray(catalog.licenses, 'catalog.licenses', 64)
  catalog.licenses.forEach(validateLicense)
  assertUniqueIds(catalog.licenses, 'catalog.licenses')
  const licenseById = new Map(catalog.licenses.map((record) => [record.id, record]))

  assertArray(catalog.notices, 'catalog.notices', 64)
  catalog.notices.forEach(validateNotice)
  assertUniqueIds(catalog.notices, 'catalog.notices')
  const noticeById = new Map(catalog.notices.map((record) => [record.id, record]))

  assertArray(catalog.variants, 'catalog.variants', 64)
  catalog.variants.forEach((variant, index) => validateVariant(variant, index, noticeById))
  assertUniqueIds(catalog.variants, 'catalog.variants')
  const variantById = new Map(catalog.variants.map((variant) => [variant.id, variant]))

  assertArray(catalog.assets, 'catalog.assets', 2048)
  catalog.assets.forEach((asset, index) => validateAsset(asset, index, variantById, licenseById))
  assertUniqueIds(catalog.assets, 'catalog.assets')

  for (const variant of catalog.variants) {
    const components = catalog.assets
      .filter((asset) => asset.variantId === variant.id)
      .map((asset) => asset.component)
    assertCaseFoldUnique(components, `variant "${variant.id}" components`)
    const expected = [...variant.componentIds].sort()
    const actual = [...components].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`variant "${variant.id}" assets do not exactly match componentIds`)
    }
  }

  assertKeys(catalog.selected, ['textVariant', 'visionVariant', 'approval'], 'catalog.selected')
  assertId(catalog.selected.textVariant, 'catalog.selected.textVariant')
  assertId(catalog.selected.visionVariant, 'catalog.selected.visionVariant')
  if (!APPROVALS.includes(catalog.selected.approval)) fail('catalog.selected.approval is invalid')
  if (variantById.get(catalog.selected.textVariant)?.role !== 'text') {
    fail('catalog.selected.textVariant must reference one text variant')
  }
  if (variantById.get(catalog.selected.visionVariant)?.role !== 'vision') {
    fail('catalog.selected.visionVariant must reference one vision variant')
  }

  const payloadDestinations = [
    ...catalog.assets.map((asset) => asset.destination),
    ...catalog.licenses.map((record) => `licenses/${basename(record.path)}`),
    ...catalog.notices.map((record) => `notices/${basename(record.path)}`)
  ]
  assertCaseFoldUnique(payloadDestinations, 'payload destinations')
  return catalog
}

export function resolveCatalogSelection(catalog, override) {
  const selection = override ?? catalog.selected
  assertKeys(selection, ['textVariant', 'visionVariant', 'approval'], 'selection')
  assertId(selection.textVariant, 'selection.textVariant')
  assertId(selection.visionVariant, 'selection.visionVariant')
  if (!APPROVALS.includes(selection.approval)) fail('selection.approval is invalid')
  const variantById = new Map(catalog.variants.map((variant) => [variant.id, variant]))
  if (variantById.get(selection.textVariant)?.role !== 'text') fail('selection needs one text variant')
  if (variantById.get(selection.visionVariant)?.role !== 'vision') fail('selection needs one vision variant')
  return { ...selection }
}

export function selectedAssets(catalog, selection, platform) {
  if (!TARGET_PLATFORMS.includes(platform)) fail(`unsupported target platform "${platform}"`)
  const selectedIds = new Set([selection.textVariant, selection.visionVariant])
  return catalog.assets.filter(
    (asset) =>
      selectedIds.has(asset.variantId) &&
      (asset.platforms.includes('all') || asset.platforms.includes(platform))
  )
}

function selectedRecordSets(catalog, variants, assets) {
  const licenseIds = new Set()
  for (const asset of assets) {
    licenseIds.add(asset.source.licenseId)
    if (asset.conversion) licenseIds.add(asset.conversion.licenseId)
  }
  const noticeIds = new Set(variants.flatMap((variant) => variant.provenance.noticeIds))
  return {
    licenses: catalog.licenses.filter((record) => licenseIds.has(record.id)),
    notices: catalog.notices.filter((record) => noticeIds.has(record.id))
  }
}

export function buildRuntimeManifest({ catalog, catalogSha256, selection, platform }) {
  validateCatalog(catalog)
  assertSha256(catalogSha256, 'catalogSha256')
  const resolved = resolveCatalogSelection(catalog, selection)
  const variantById = new Map(catalog.variants.map((variant) => [variant.id, variant]))
  const text = variantById.get(resolved.textVariant)
  const vision = variantById.get(resolved.visionVariant)

  if (
    resolved.approval === 'release' &&
    (catalog.selected.approval !== 'release' ||
      resolved.textVariant !== catalog.selected.textVariant ||
      resolved.visionVariant !== catalog.selected.visionVariant)
  ) {
    fail('release manifests must use the catalog-approved release selection')
  }

  const noticeById = new Map(catalog.notices.map((notice) => [notice.id, notice]))
  for (const variant of [text, vision]) {
    if (
      resolved.approval === 'release' &&
      variant.provenance.status === 'review-required' &&
      !variant.provenance.noticeIds.some((id) => noticeById.get(id)?.kind === 'release-exception')
    ) {
      fail(`variant "${variant.id}" needs a reviewed release-exception notice`)
    }
  }

  const assets = selectedAssets(catalog, resolved, platform)
  for (const variant of [text, vision]) {
    const components = assets
      .filter((asset) => asset.variantId === variant.id)
      .map((asset) => asset.component)
      .sort()
    if (JSON.stringify(components) !== JSON.stringify([...variant.componentIds].sort())) {
      fail(`variant "${variant.id}" is incomplete for ${platform}`)
    }
  }

  const records = selectedRecordSets(catalog, [text, vision], assets)
  return {
    schemaVersion: SCHEMA_VERSION,
    targetPlatform: platform,
    catalogSha256,
    approval: resolved.approval,
    selected: {
      text: { id: text.id, model: text.model, precision: text.precision, runtime: text.runtime },
      vision: { id: vision.id, model: vision.model, precision: vision.precision, runtime: vision.runtime }
    },
    assets: assets
      .map((asset) => ({
        id: asset.id,
        variantId: asset.variantId,
        component: asset.component,
        destination: asset.destination,
        bytes: asset.source.bytes,
        sha256: asset.source.sha256
      }))
      .sort(compareDestination),
    licenses: records.licenses
      .map((record) => ({
        id: record.id,
        destination: `licenses/${basename(record.path)}`,
        bytes: record.bytes,
        sha256: record.sha256
      }))
      .sort(compareDestination),
    notices: records.notices
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        destination: `notices/${basename(record.path)}`,
        bytes: record.bytes,
        sha256: record.sha256
      }))
      .sort(compareDestination)
  }
}

export function serializeRuntimeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function catalogDownloadPlan(catalog, { allCandidates = false } = {}) {
  validateCatalog(catalog)
  const selectedIds = new Set([catalog.selected.textVariant, catalog.selected.visionVariant])
  return catalog.assets
    .filter((asset) => allCandidates || selectedIds.has(asset.variantId))
    .sort(compareDestination)
}

const MAX_CATALOG_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

async function assertRegularContainedFile(root, file, label) {
  let rootStats
  try {
    rootStats = await fs.lstat(root)
  } catch {
    fail(`${label} root is missing`)
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail(`${label} root must be a real directory`)
  }

  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) fail(`${label} escapes its root`)
  const segments = rel.split(sep)
  let current = root
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    let stats
    try {
      stats = await fs.lstat(current)
    } catch {
      fail(`${label} ancestor is missing`)
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail(`${label} ancestor must be a real directory`)
    }
  }

  let stats
  try {
    stats = await fs.lstat(file)
  } catch {
    fail(`${label} is missing`)
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular file`)
  if (stats.nlink !== 1) fail(`${label} must not be hardlinked`)
  return stats
}

async function verifyRecordFile(root, relativePath, expectedBytes, expectedSha256, label) {
  const file = join(root, relativePath)
  const stats = await assertRegularContainedFile(root, file, label)
  if (stats.size !== expectedBytes || stats.size === 0) fail(`${label} size does not match its record`)
  const actualSha256 = await hashFile(file)
  if (actualSha256 !== expectedSha256) fail(`${label} SHA-256 does not match its record`)
}

async function listPayloadFiles(root) {
  const files = []
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) fail(`payload contains symlink "${relative(root, absolute)}"`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'))
      else fail(`payload contains non-regular entry "${relative(root, absolute)}"`)
    }
  }
  await visit(root)
  return files.sort()
}

export function loadCatalog(catalogPath) {
  const stats = lstatSync(catalogPath)
  if (!stats.isFile() || stats.isSymbolicLink()) fail('catalog must be a regular file')
  if (stats.size === 0 || stats.size > MAX_CATALOG_BYTES) fail('catalog size is invalid')
  const raw = readFileSync(catalogPath)
  const catalogSha256 = createHash('sha256').update(raw).digest('hex')
  let parsed
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    fail('catalog is not valid JSON')
  }
  return { catalog: validateCatalog(parsed), catalogSha256 }
}

export async function hashFile(file) {
  const stats = await fs.lstat(file)
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${file} must be a regular file`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function cachePathForAsset(cacheRoot, asset) {
  assertId(asset.id, 'asset.id')
  assertSafeRelativePath(asset.source?.path, 'asset.source.path')
  const root = resolve(cacheRoot)
  const file = resolve(root, asset.id, basename(asset.source.path))
  const rel = relative(root, file)
  if (rel.startsWith('..') || isAbsolute(rel)) fail('cache path escapes its root')
  return file
}

export async function verifyTrackedRecords({ catalog, repoRoot }) {
  validateCatalog(catalog)
  const root = resolve(repoRoot)
  for (const record of catalog.licenses) {
    await verifyRecordFile(root, record.path, record.bytes, record.sha256, `license "${record.id}"`)
  }
  for (const record of catalog.notices) {
    await verifyRecordFile(root, record.path, record.bytes, record.sha256, `notice "${record.id}"`)
  }
}

export async function verifySelectedCache({ catalog, cacheRoot, selection, platform }) {
  validateCatalog(catalog)
  const resolvedSelection = resolveCatalogSelection(catalog, selection)
  const root = resolve(cacheRoot)
  for (const asset of selectedAssets(catalog, resolvedSelection, platform)) {
    const file = cachePathForAsset(root, asset)
    await verifyRecordFile(
      root,
      relative(root, file),
      asset.source.bytes,
      asset.source.sha256,
      `asset "${asset.id}"`
    )
  }
}

export async function verifyPayload({
  catalog,
  catalogSha256,
  payloadRoot,
  platform,
  requireRelease = false
}) {
  validateCatalog(catalog)
  assertSha256(catalogSha256, 'catalogSha256')
  if (!TARGET_PLATFORMS.includes(platform)) fail(`unsupported target platform "${platform}"`)

  const root = resolve(payloadRoot)
  const manifestFile = join(root, 'manifest.json')
  const manifestStats = await assertRegularContainedFile(root, manifestFile, 'manifest.json')
  if (manifestStats.size === 0 || manifestStats.size > MAX_MANIFEST_BYTES) fail('manifest size is invalid')
  const rawManifest = await fs.readFile(manifestFile, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(rawManifest)
  } catch {
    fail('manifest is not valid JSON')
  }
  assertObject(parsed, 'manifest')
  assertObject(parsed.selected, 'manifest.selected')
  assertId(parsed.selected.text?.id, 'manifest.selected.text.id')
  assertId(parsed.selected.vision?.id, 'manifest.selected.vision.id')
  if (!APPROVALS.includes(parsed.approval)) fail('manifest.approval is invalid')

  const expected = buildRuntimeManifest({
    catalog,
    catalogSha256,
    selection: {
      textVariant: parsed.selected.text.id,
      visionVariant: parsed.selected.vision.id,
      approval: parsed.approval
    },
    platform
  })
  if (serializeRuntimeManifest(expected) !== rawManifest) {
    fail('manifest is not canonical for this catalog, platform, and selection')
  }
  if (requireRelease && expected.approval !== 'release') fail('release approval is required')

  const records = [...expected.assets, ...expected.licenses, ...expected.notices]
  const expectedFiles = [...records.map((record) => record.destination), 'manifest.json'].sort()
  const actualFiles = await listPayloadFiles(root)
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('payload file set does not exactly match its manifest')
  }
  for (const record of records) {
    await verifyRecordFile(root, record.destination, record.bytes, record.sha256, `payload "${record.destination}"`)
  }
  return expected
}
