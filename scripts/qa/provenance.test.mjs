// scripts/qa/provenance.test.mjs — behaviour tests for the build-once candidate lane (M2-0187).
//
// Every test exercises real files under a fresh mkdtemp() root, or the real CLI via spawnSync, never a
// regex over source text. Fixture rule: no literal high-entropy hex — hashes come from createHash, and
// commits/fingerprints use 'a'.repeat(40)-style values so nothing here looks like a leaked secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VARIANTS,
  PROMOTABLE_VARIANTS,
  stageBuild,
  assembleProvenance,
  sha256Sums,
  directoryProblems,
  evidenceProblems,
  prepareRelease,
  releaseNotes,
  uploadProblems
} from './provenance.mjs'

const MODULE_PATH = fileURLToPath(new URL('./provenance.mjs', import.meta.url))
const VERSION = '1.9.7'
const NODE_VERSION = 'v22.22.3'

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** A temp repo root holding everything stageBuild reads: package.json, the two dependency versions
 *  stageBuild inspects, every builder-config file each variant extends, and release/ pre-populated
 *  with every variant's expected installers (distinct content per file, so hashes differ). */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'provenance-fixture-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'metis', version: VERSION }, null, 2))
  mkdirSync(join(root, 'node_modules', 'electron'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '43.6.0' }))
  mkdirSync(join(root, 'node_modules', 'electron-builder'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'electron-builder', 'package.json'), JSON.stringify({ version: '26.15.3' }))
  writeFileSync(join(root, 'electron-builder.yml'), 'base config for the fixture\n')
  writeFileSync(join(root, 'electron-builder.win.yml'), 'windows config for the fixture\n')
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'build', 'qa-identity.electron-builder.yml'), 'qa identity config for the fixture\n')
  const releaseDir = join(root, 'release')
  mkdirSync(releaseDir, { recursive: true })
  for (const config of Object.values(VARIANTS)) {
    for (const name of config.assets(VERSION)) {
      writeFileSync(join(releaseDir, name), `content of ${name}\n`)
    }
  }
  return { root, releaseDir }
}

function env(overrides = {}) {
  return {
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '42',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
    ImageOS: 'macos15',
    ImageVersion: '20260915.1',
    ...overrides
  }
}

async function stageAll(root, releaseDir, overrides = {}) {
  const e = env(overrides)
  const records = []
  for (const variant of Object.keys(VARIANTS)) {
    const record = await stageBuild({
      variant,
      repoRoot: root,
      releaseDir,
      outDir: join(root, 'staged', variant),
      env: e,
      nodeVersion: NODE_VERSION
    })
    records.push(record)
  }
  return { records, env: e }
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true })
}

/** Copies every promotable variant's staged assets into `downloadsDir`, as the promotion job does. */
function copyPromotableAssetsToDownloads(root, provenance, downloadsDir) {
  for (const variant of PROMOTABLE_VARIANTS) {
    for (const asset of provenance.builds.find((b) => b.variant === variant).assets) {
      writeFileSync(join(downloadsDir, asset.name), readFileSync(join(root, 'staged', variant, 'assets', asset.name)))
    }
  }
}

/** One passing evidence-record line (JSON Lines), bound to `provenance`'s run and the given asset sha256. */
function passEvidenceLine(provenance, assetSha256, ticket = 'M2-0028') {
  return `${JSON.stringify({ ticket, result: 'PASS', build_run_id: provenance.run.id, artifact_sha256: assetSha256 })}\n`
}

test('stage moves exactly the variant\'s installers and records size and sha256', async () => {
  const { root, releaseDir } = fixture()
  try {
    const outDir = join(root, 'out')
    const record = await stageBuild({ variant: 'mac', repoRoot: root, releaseDir, outDir, env: env(), nodeVersion: NODE_VERSION })
    for (const name of VARIANTS.mac.assets(VERSION)) {
      const staged = join(outDir, 'assets', name)
      assert.ok(existsSync(staged), `${name} was not staged`)
      assert.ok(!existsSync(join(releaseDir, name)), `${name} was not removed from release/`)
      const bytes = readFileSync(staged)
      const asset = record.assets.find((a) => a.name === name)
      assert.ok(asset, `record has no asset ${name}`)
      assert.equal(asset.sha256, sha256(bytes))
      assert.equal(asset.size, bytes.length)
    }
    for (const name of VARIANTS.win.assets(VERSION)) {
      assert.ok(existsSync(join(releaseDir, name)), `${name} should remain in release/ untouched`)
    }
    for (const name of VARIANTS['mac-qa-identity'].assets(VERSION)) {
      assert.ok(existsSync(join(releaseDir, name)), `${name} should remain in release/ untouched`)
    }
  } finally {
    cleanup(root)
  }
})

test('stage records the runner image, Node, Electron, electron-builder and per-file builder config hashes', async () => {
  const { root, releaseDir } = fixture()
  try {
    const outDir = join(root, 'out')
    const e = env()
    const record = await stageBuild({ variant: 'mac-qa-identity', repoRoot: root, releaseDir, outDir, env: e, nodeVersion: NODE_VERSION })
    assert.deepEqual(record.runner, { os: e.RUNNER_OS, arch: e.RUNNER_ARCH, image: e.ImageOS, image_version: e.ImageVersion })
    assert.equal(record.node, NODE_VERSION)
    assert.equal(record.electron, '43.6.0')
    assert.equal(record.electron_builder, '26.15.3')
    assert.deepEqual(record.builder_config.map((c) => c.path), VARIANTS['mac-qa-identity'].configs)
    for (const config of record.builder_config) {
      assert.equal(config.sha256, sha256(readFileSync(join(root, config.path))))
    }
  } finally {
    cleanup(root)
  }
})

test('stage refuses a missing installer and moves nothing', async () => {
  const { root, releaseDir } = fixture()
  try {
    const [missing] = VARIANTS.win.assets(VERSION)
    rmSync(join(releaseDir, missing))
    const outDir = join(root, 'out')
    await assert.rejects(
      stageBuild({ variant: 'win', repoRoot: root, releaseDir, outDir, env: env(), nodeVersion: NODE_VERSION }),
      (error) => error.message.includes(missing)
    )
    assert.equal(existsSync(outDir), false, 'stage must move nothing before it fails')
    for (const name of VARIANTS.win.assets(VERSION)) {
      if (name === missing) continue
      assert.ok(existsSync(join(releaseDir, name)))
    }
  } finally {
    cleanup(root)
  }
})

test('stage refuses a missing builder-config file and moves nothing', async () => {
  const { root, releaseDir } = fixture()
  try {
    rmSync(join(root, 'electron-builder.yml'))
    const outDir = join(root, 'out')
    await assert.rejects(
      stageBuild({ variant: 'mac', repoRoot: root, releaseDir, outDir, env: env(), nodeVersion: NODE_VERSION }),
      (error) => error.message.includes('electron-builder.yml')
    )
    assert.equal(existsSync(outDir), false, 'stage must move nothing before it fails')
    for (const name of VARIANTS.mac.assets(VERSION)) {
      assert.ok(existsSync(join(releaseDir, name)), `${name} should remain in release/ untouched`)
    }
  } finally {
    cleanup(root)
  }
})

test('stage refuses a build without the runner image', async () => {
  const { root, releaseDir } = fixture()
  try {
    const outDir = join(root, 'out')
    await assert.rejects(
      stageBuild({ variant: 'win', repoRoot: root, releaseDir, outDir, env: env({ ImageOS: '' }), nodeVersion: NODE_VERSION }),
      (error) => error.message.includes('ImageOS')
    )
    assert.equal(existsSync(outDir), false)
    for (const name of VARIANTS.win.assets(VERSION)) {
      assert.ok(existsSync(join(releaseDir, name)))
    }
  } finally {
    cleanup(root)
  }
})

test('stage records the mac identity from the environment, ad-hoc without it, and unsigned on Windows even with it set', async () => {
  const { root, releaseDir } = fixture()
  try {
    const fingerprint = 'A'.repeat(40)
    const withIdentity = await stageBuild({
      variant: 'mac',
      repoRoot: root,
      releaseDir,
      outDir: join(root, 'out-mac'),
      env: env({ ASKTOTO_MAC_SIGN_IDENTITY: fingerprint }),
      nodeVersion: NODE_VERSION
    })
    assert.deepEqual(withIdentity.signing, { mode: 'qa-identity', certificate_sha1: fingerprint.toLowerCase() })

    const withoutIdentity = await stageBuild({
      variant: 'mac-qa-identity',
      repoRoot: root,
      releaseDir,
      outDir: join(root, 'out-mac-qa'),
      env: env(),
      nodeVersion: NODE_VERSION
    })
    assert.deepEqual(withoutIdentity.signing, { mode: 'ad-hoc' })

    const win = await stageBuild({
      variant: 'win',
      repoRoot: root,
      releaseDir,
      outDir: join(root, 'out-win'),
      env: env({ ASKTOTO_MAC_SIGN_IDENTITY: fingerprint }),
      nodeVersion: NODE_VERSION
    })
    assert.deepEqual(win.signing, { mode: 'unsigned' })
  } finally {
    cleanup(root)
  }
})

test('stage refuses a malformed signing identity', async () => {
  const { root, releaseDir } = fixture()
  try {
    await assert.rejects(
      stageBuild({
        variant: 'mac',
        repoRoot: root,
        releaseDir,
        outDir: join(root, 'out'),
        env: env({ ASKTOTO_MAC_SIGN_IDENTITY: 'not-a-fingerprint' }),
        nodeVersion: NODE_VERSION
      }),
      (error) => error.message.includes('ASKTOTO_MAC_SIGN_IDENTITY')
    )
  } finally {
    cleanup(root)
  }
})

test('assemble binds every build to one commit and run and lists every asset in SHA256SUMS', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    assert.equal(provenance.schema, 1)
    assert.equal(provenance.commit, e.GITHUB_SHA)
    assert.equal(provenance.version, VERSION)
    assert.equal(provenance.run.id, Number(e.GITHUB_RUN_ID))
    assert.equal(provenance.run.url, `${e.GITHUB_SERVER_URL}/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`)
    assert.deepEqual(provenance.builds.map((b) => b.variant), ['mac', 'mac-qa-identity', 'win'])
    for (const build of provenance.builds) {
      assert.equal(Object.hasOwn(build, 'commit'), false)
      assert.equal(Object.hasOwn(build, 'version'), false)
    }
    const allAssets = provenance.builds.flatMap((b) => b.assets)
    const sums = sha256Sums(allAssets)
    const lines = sums.split('\n').filter(Boolean)
    assert.equal(lines.length, allAssets.length)
    const sortedNames = [...allAssets].sort((a, b) => a.name.localeCompare(b.name)).map((a) => a.name)
    assert.deepEqual(lines.map((l) => l.split('  ')[1]), sortedNames)
    for (const line of lines) assert.match(line, /^[0-9a-f]{64}  \S+$/)
  } finally {
    cleanup(root)
  }
})

test('assemble refuses a missing or duplicated variant, a foreign commit and mismatched versions', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)

    assert.throws(() => assembleProvenance(records.slice(1), e), (error) => error.message.includes('missing variant: mac'))
    assert.throws(() => assembleProvenance([...records, records[0]], e), (error) => error.message.includes('duplicate variant: mac'))

    const foreignCommit = records.map((r, i) => (i === 0 ? { ...r, commit: 'b'.repeat(40) } : r))
    assert.throws(() => assembleProvenance(foreignCommit, e), (error) => error.message.includes('commit'))

    const mismatchedVersion = records.map((r, i) => (i === 0 ? { ...r, version: '9.9.9' } : r))
    assert.throws(() => assembleProvenance(mismatchedVersion, e), (error) => error.message.includes('version'))
  } finally {
    cleanup(root)
  }
})

test('verify accepts the exact bytes and names a changed byte, a missing file and an extra file', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    const dir = join(root, 'downloads-mac')
    mkdirSync(dir, { recursive: true })
    const macAssets = provenance.builds.find((b) => b.variant === 'mac').assets
    for (const asset of macAssets) {
      writeFileSync(join(dir, asset.name), readFileSync(join(root, 'staged', 'mac', 'assets', asset.name)))
    }

    assert.deepEqual(await directoryProblems(provenance, dir, ['mac']), [])

    const [firstAsset] = macAssets
    const original = readFileSync(join(dir, firstAsset.name))
    const flipped = Buffer.from(original)
    flipped[0] = flipped[0] ^ 0xff
    assert.equal(flipped.length, original.length)
    writeFileSync(join(dir, firstAsset.name), flipped)
    let problems = await directoryProblems(provenance, dir, ['mac'])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /sha256/)
    writeFileSync(join(dir, firstAsset.name), original)

    rmSync(join(dir, firstAsset.name))
    problems = await directoryProblems(provenance, dir, ['mac'])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /missing/)
    writeFileSync(join(dir, firstAsset.name), original)

    writeFileSync(join(dir, 'unexpected-file.bin'), 'surprise')
    problems = await directoryProblems(provenance, dir, ['mac'])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /unexpected/)
  } finally {
    cleanup(root)
  }
})

test('evidence needs at least one PASS record bound to this run and its bytes', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    assert.deepEqual(evidenceProblems('', provenance), [
      'no evidence records: promotion needs at least one passing record bound to these bytes'
    ])
    const sha = provenance.builds[0].assets[0].sha256
    const line = JSON.stringify({ ticket: 'M2-0028', result: 'PASS', build_run_id: provenance.run.id, artifact_sha256: sha })
    assert.deepEqual(evidenceProblems(line, provenance), [])
    assert.deepEqual(evidenceProblems(`${line}\n`, provenance), [])
    // A CRLF file (the schema explicitly allows one) can end in a repeated line ending; every repetition
    // must be stripped, not just the last one, or the leftover 'x\r\n' misreports as a blank line 2.
    assert.deepEqual(evidenceProblems(`${line}\r\n\r\n`, provenance), [])
  } finally {
    cleanup(root)
  }
})

test('evidence problems name the line', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    const sha = provenance.builds[0].assets[0].sha256
    const good = (overrides = {}) =>
      JSON.stringify({ ticket: 'M2-0028', result: 'PASS', build_run_id: provenance.run.id, artifact_sha256: sha, ...overrides })

    let problems = evidenceProblems(good({ result: 'FAIL' }), provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /line 1/)
    assert.match(problems[0], /FAIL/)

    problems = evidenceProblems(good({ build_run_id: provenance.run.id + 1 }), provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], new RegExp(`run ${provenance.run.id + 1}`))
    assert.match(problems[0], new RegExp(`run ${provenance.run.id}\\b`))

    problems = evidenceProblems(good({ artifact_sha256: 'f'.repeat(64) }), provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /line 1/)

    problems = evidenceProblems(good({ ticket: 'not-a-ticket' }), provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ticket/)

    problems = evidenceProblems('{not json', provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /not valid JSON/)

    problems = evidenceProblems([good(), good(), '', good()].join('\n'), provenance)
    assert.equal(problems.length, 1)
    assert.match(problems[0], /line 3 is blank/)
  } finally {
    cleanup(root)
  }
})

test('prepare-release publishes only the shipping installers with SHA256SUMS.txt and the original provenance.json', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    const provenancePath = join(root, 'provenance.json')
    const provenanceBytes = `${JSON.stringify(provenance, null, 2)}\n`
    writeFileSync(provenancePath, provenanceBytes)

    const downloadsDir = join(root, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    copyPromotableAssetsToDownloads(root, provenance, downloadsDir)
    // The QA-identity zip is never handed to promotion at all: it lives only where build-mac-qa-identity staged it.
    const qaAsset = provenance.builds.find((b) => b.variant === 'mac-qa-identity').assets[0]
    const qaZipElsewhere = join(root, 'staged', 'mac-qa-identity', 'assets', qaAsset.name)
    assert.ok(existsSync(qaZipElsewhere))

    const evidencePath = join(root, 'evidence.jsonl')
    const macSha = provenance.builds.find((b) => b.variant === 'mac').assets[0].sha256
    writeFileSync(evidencePath, passEvidenceLine(provenance, macSha))

    const outDir = join(root, 'promotion')
    await prepareRelease({
      provenancePath,
      evidencePath,
      downloadsDir,
      outDir,
      candidateRun: String(provenance.run.id),
      candidateCommit: provenance.commit,
      env: e
    })

    const uploadDir = join(outDir, 'upload')
    const uploaded = readdirSync(uploadDir).sort()
    const promotableAssetNames = provenance.builds
      .filter((b) => PROMOTABLE_VARIANTS.includes(b.variant))
      .flatMap((b) => b.assets.map((a) => a.name))
    assert.deepEqual(uploaded, [...promotableAssetNames, 'SHA256SUMS.txt', 'provenance.json'].sort())
    assert.equal(uploaded.length, 6)

    const sums = readFileSync(join(uploadDir, 'SHA256SUMS.txt'), 'utf8').split('\n').filter(Boolean)
    assert.equal(sums.length, 4)

    assert.deepEqual(readFileSync(join(uploadDir, 'provenance.json')), Buffer.from(provenanceBytes))

    // The QA zip is still exactly where it was: prepareRelease never touched it.
    assert.ok(existsSync(qaZipElsewhere))

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.length, 6)
    for (const entry of manifest) {
      assert.ok(typeof entry.name === 'string' && typeof entry.size === 'number' && /^[0-9a-f]{64}$/.test(entry.sha256))
    }

    assert.ok(existsSync(join(outDir, 'notes.md')))
  } finally {
    cleanup(root)
  }
})

test('prepare-release refuses unbound provenance or refused evidence and moves nothing', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    const provenancePath = join(root, 'provenance.json')
    writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)
    const downloadsDir = join(root, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    copyPromotableAssetsToDownloads(root, provenance, downloadsDir)
    const evidencePath = join(root, 'evidence.jsonl')
    const macSha = provenance.builds.find((b) => b.variant === 'mac').assets[0].sha256
    writeFileSync(evidencePath, passEvidenceLine(provenance, macSha))

    const outDir1 = join(root, 'promotion-wrong-run')
    await assert.rejects(
      prepareRelease({
        provenancePath,
        evidencePath,
        downloadsDir,
        outDir: outDir1,
        candidateRun: String(provenance.run.id + 1),
        candidateCommit: provenance.commit,
        env: e
      }),
      (error) => error.message.includes('run')
    )
    assert.equal(existsSync(join(outDir1, 'upload')), false)

    const outDir2 = join(root, 'promotion-wrong-commit')
    await assert.rejects(
      prepareRelease({
        provenancePath,
        evidencePath,
        downloadsDir,
        outDir: outDir2,
        candidateRun: String(provenance.run.id),
        candidateCommit: 'b'.repeat(40),
        env: e
      }),
      (error) => error.message.includes('commit')
    )
    assert.equal(existsSync(join(outDir2, 'upload')), false)

    // Bytes with correct run and commit, but no PASS record bound to them, must still be refused.
    const failEvidencePath = join(root, 'evidence-fail.jsonl')
    writeFileSync(
      failEvidencePath,
      `${JSON.stringify({ ticket: 'M2-0028', result: 'FAIL', build_run_id: provenance.run.id, artifact_sha256: macSha })}\n`
    )
    const outDir3 = join(root, 'promotion-failed-evidence')
    await assert.rejects(
      prepareRelease({
        provenancePath,
        evidencePath: failEvidencePath,
        downloadsDir,
        outDir: outDir3,
        candidateRun: String(provenance.run.id),
        candidateCommit: provenance.commit,
        env: e
      }),
      (error) => error.message.includes('line 1') && error.message.includes('FAIL')
    )
    assert.equal(existsSync(join(outDir3, 'upload')), false)

    for (const variant of PROMOTABLE_VARIANTS) {
      for (const asset of provenance.builds.find((b) => b.variant === variant).assets) {
        assert.ok(existsSync(join(downloadsDir, asset.name)))
      }
    }
  } finally {
    cleanup(root)
  }
})

test('release notes state version, commit, candidate run, promotion run, not-Latest wording, signing and the evidence hash', async () => {
  const { root, releaseDir } = fixture()
  try {
    const { records, env: e } = await stageAll(root, releaseDir)
    const provenance = assembleProvenance(records, e)
    const promotionRunUrl = 'https://github.com/owner/repo/actions/runs/99'
    const evidence = { count: 2, tickets: ['M2-0028', 'M2-0060'], sha256: sha256('evidence bytes') }

    const notes = releaseNotes({ provenance, evidence, promotionRunUrl })
    assert.match(notes, new RegExp(provenance.version.replace(/\./g, '\\.')))
    assert.ok(notes.includes(provenance.commit))
    assert.ok(notes.includes(String(provenance.run.id)))
    assert.ok(notes.includes(provenance.run.url))
    assert.ok(notes.includes(promotionRunUrl))
    // "not Latest" wording: the owner channel and hand-install framing, never auto-update.
    assert.ok(notes.includes('Owner-channel'))
    assert.ok(notes.includes('In-app update does not offer this build'))
    assert.ok(notes.includes(evidence.sha256))
    assert.ok(notes.includes('M2-0028'))
    assert.ok(notes.includes('M2-0060'))
    for (const asset of provenance.builds.filter((b) => PROMOTABLE_VARIANTS.includes(b.variant)).flatMap((b) => b.assets)) {
      assert.ok(notes.includes(asset.name))
      assert.ok(notes.includes(asset.sha256))
    }
    const qaAsset = provenance.builds.find((b) => b.variant === 'mac-qa-identity').assets[0]
    assert.ok(!notes.includes(qaAsset.name), 'the QA-identity asset is never promoted, so it must not appear')

    assert.ok(notes.includes('ad-hoc signed and not notarized'))

    const qaSigned = JSON.parse(JSON.stringify(provenance))
    qaSigned.builds.find((b) => b.variant === 'mac').signing = { mode: 'qa-identity', certificate_sha1: 'a'.repeat(40) }
    const qaNotes = releaseNotes({ provenance: qaSigned, evidence, promotionRunUrl })
    assert.ok(qaNotes.includes('self-signed QA certificate'))
    assert.ok(qaNotes.includes('a'.repeat(40)))
  } finally {
    cleanup(root)
  }
})

test('check-release accepts matching digests and refuses a missing, extra, resized, not-uploaded or undigested asset', () => {
  const manifest = [
    { name: 'Metis-1.9.7.dmg', size: 100, sha256: sha256('a') },
    { name: 'Metis-1.9.7.zip', size: 200, sha256: sha256('b') }
  ]
  const uploadedFor = (m) => m.map((a) => ({ name: a.name, size: a.size, state: 'uploaded', digest: `sha256:${a.sha256}` }))

  assert.deepEqual(uploadProblems(manifest, uploadedFor(manifest)), [])

  assert.equal(uploadProblems(manifest, uploadedFor(manifest).slice(1)).length, 1)

  const extra = [...uploadedFor(manifest), { name: 'surprise.txt', size: 5, state: 'uploaded', digest: `sha256:${sha256('c')}` }]
  assert.equal(uploadProblems(manifest, extra).length, 1)

  const resized = uploadedFor(manifest)
  resized[0] = { ...resized[0], size: resized[0].size + 1 }
  assert.equal(uploadProblems(manifest, resized).length, 1)

  const notUploaded = uploadedFor(manifest)
  notUploaded[0] = { ...notUploaded[0], state: 'processing' }
  assert.equal(uploadProblems(manifest, notUploaded).length, 1)

  const undigested = uploadedFor(manifest)
  undigested[0] = { ...undigested[0], digest: null }
  const problems = uploadProblems(manifest, undigested)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no digest/)
})

test('the CLI stages, assembles, verifies and prepares a release end to end', async () => {
  const { root, releaseDir } = fixture()
  try {
    const e = env()
    const run = (args) =>
      spawnSync(process.execPath, [MODULE_PATH, ...args], {
        cwd: root,
        env: { ...process.env, ...e },
        encoding: 'utf8'
      })

    for (const variant of Object.keys(VARIANTS)) {
      const result = run(['stage', variant, 'release', join('staged', variant)])
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    }

    const recordsDir = join(root, 'records')
    mkdirSync(recordsDir, { recursive: true })
    for (const variant of Object.keys(VARIANTS)) {
      writeFileSync(join(recordsDir, `build-${variant}.json`), readFileSync(join(root, 'staged', variant, `build-${variant}.json`)))
    }

    const assembleResult = run(['assemble', 'records', 'provenance'])
    assert.equal(assembleResult.status, 0, `${assembleResult.stdout}\n${assembleResult.stderr}`)
    const provenance = JSON.parse(readFileSync(join(root, 'provenance', 'provenance.json'), 'utf8'))
    assert.ok(existsSync(join(root, 'provenance', 'SHA256SUMS.txt')))

    const verifyResult = run(['verify', join('provenance', 'provenance.json'), join('staged', 'mac', 'assets'), 'mac'])
    assert.equal(verifyResult.status, 0, `${verifyResult.stdout}\n${verifyResult.stderr}`)

    const macAsset = provenance.builds.find((b) => b.variant === 'mac').assets[0]
    const assetPath = join(root, 'staged', 'mac', 'assets', macAsset.name)
    const original = readFileSync(assetPath)
    const flipped = Buffer.from(original)
    flipped[0] ^= 0xff
    writeFileSync(assetPath, flipped)
    const corruptedVerify = run(['verify', join('provenance', 'provenance.json'), join('staged', 'mac', 'assets'), 'mac'])
    assert.equal(corruptedVerify.status, 1)
    writeFileSync(assetPath, original)

    const downloadsDir = join(root, 'downloads')
    mkdirSync(downloadsDir, { recursive: true })
    copyPromotableAssetsToDownloads(root, provenance, downloadsDir)
    const evidencePath = join(root, 'evidence.jsonl')
    writeFileSync(evidencePath, passEvidenceLine(provenance, macAsset.sha256))
    const prepareResult = run([
      'prepare-release',
      join('provenance', 'provenance.json'),
      'evidence.jsonl',
      'downloads',
      'promotion',
      '--candidate-run',
      String(provenance.run.id),
      '--candidate-commit',
      provenance.commit
    ])
    assert.equal(prepareResult.status, 0, `${prepareResult.stdout}\n${prepareResult.stderr}`)
    assert.ok(existsSync(join(root, 'promotion', 'upload', 'SHA256SUMS.txt')))

    const usageResult = run(['bogus-command'])
    assert.equal(usageResult.status, 2)
  } finally {
    cleanup(root)
  }
})
