#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA256 = /^[0-9a-f]{64}$/
const IMAGE = /\.(png|jpe?g|heic)$/i

export function parseArgs(argv) {
  const args = { out: 'out/owner-camera' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const value = argv[++i]
    if (!value) throw new Error(`${arg} requires a value`)
    args[key] = value
  }
  return args
}

export function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

export function validateInputs(args) {
  const problems = []
  if (!args.dmg) problems.push('--dmg is required')
  else if (!existsSync(args.dmg)) problems.push('--dmg does not exist')
  if (!SHA256.test(String(args.sha256 || '').trim().toLowerCase())) problems.push('--sha256 must be 64 lowercase hex characters')
  if (!/^[0-9]+$/.test(String(args.candidateRun || ''))) problems.push('--candidate-run must be a numeric run id')
  if (args.buildRun && !/^[0-9]+$/.test(String(args.buildRun))) problems.push('--build-run must be a numeric run id')
  if (problems.length) throw new Error(problems.join('\n'))
}

export function summarizeNewImages(before, dir) {
  const previous = new Set(before)
  const files = readdirSync(dir)
    .filter((name) => IMAGE.test(name) && !previous.has(name))
    .map((name) => ({ name, size: statSync(join(dir, name)).size }))
  return {
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    names: files.map((file) => file.name).sort()
  }
}

export function contentFreeReport({ appReport, images, args, deleted }) {
  const result = appReport.result === 'PASS'
    ? (images.count === 1 && images.bytes > 0 && deleted ? 'PASS' : 'FAIL')
    : appReport.result
  return {
    schema: 1,
    ticket: 'M2-0572',
    kind: 'owner-mac',
    result,
    camera_device_present: appReport.cameraDevicePresent,
    approval_prompt_shown: appReport.approvalPromptShown === true,
    explicit_approval_accepted: appReport.explicitApprovalAccepted === true,
    image_files_created: images.count,
    image_bytes: images.bytes,
    image_deleted: deleted,
    ci_run_id: process.env.GITHUB_RUN_ID || null,
    build_run_id: String(args.buildRun || args.candidateRun),
    artifact_sha256: String(args.sha256).toLowerCase(),
    environment: { kind: 'owner-mac', host: 'metis-owner-mac' },
    ...(appReport.reason ? { reason: appReport.reason } : {})
  }
}

function plistValue(plist, key) {
  const out = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()
  if (!out) throw new Error(`${key} is empty in ${plist}`)
  return out
}

function installDmg(dmg, installRoot) {
  const mount = mkdtempSync(join(process.env.RUNNER_TEMP || '/tmp', 'owner-camera-mount-'))
  let attached = false
  try {
    execFileSync('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount], { stdio: 'pipe' })
    attached = true
    const app = readdirSync(mount).find((name) => name.endsWith('.app'))
    if (!app) throw new Error('candidate DMG did not contain an app bundle')
    const from = join(mount, app)
    const to = join(installRoot, app)
    execFileSync('/usr/bin/ditto', [from, to], { stdio: 'pipe' })
    const executable = plistValue(join(to, 'Contents', 'Info.plist'), 'CFBundleExecutable')
    return join(to, 'Contents', 'MacOS', executable)
  } finally {
    if (attached) spawnSync('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' })
    rmSync(mount, { recursive: true, force: true })
  }
}

export function runCandidate(executable, dirs) {
  const result = spawnSync(executable, [], {
    env: {
      ...process.env,
      ASKTOTO_USERDATA: dirs.profile,
      ASKTOTO_LOCAL_KEYSTORE: '1',
      ASKTOTO_QA_MOCK_KEYCHAIN: '1',
      METIS_OWNER_CAMERA_DIR: dirs.photos,
      METIS_OWNER_CAMERA_REPORT: dirs.appReport,
      METIS_OWNER_CAMERA_APPROVED: '1'
    },
    cwd: dirname(executable),
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`candidate exited ${result.status}`)
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  validateInputs(args)
  const dmg = resolve(args.dmg)
  const expected = String(args.sha256).toLowerCase()
  const actual = sha256File(dmg)
  if (actual !== expected) throw new Error(`candidate sha256 mismatch: expected ${expected}, got ${actual}`)

  const out = resolve(args.out)
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || '/tmp', 'owner-camera-'))
  const dirs = {
    install: join(work, 'install'),
    profile: join(work, 'profile'),
    photos: join(work, 'photos'),
    appReport: join(work, 'app-report.json')
  }
  for (const dir of [out, dirs.install, dirs.profile, dirs.photos]) mkdirSync(dir, { recursive: true, mode: 0o700 })

  try {
    const executable = installDmg(dmg, dirs.install)
    const before = readdirSync(dirs.photos).filter((name) => IMAGE.test(name))
    runCandidate(executable, dirs)
    if (!existsSync(dirs.appReport)) throw new Error('candidate did not write owner camera report')
    const appReport = JSON.parse(readFileSync(dirs.appReport, 'utf8'))
    const images = summarizeNewImages(before, dirs.photos)
    let deleted = false
    try {
      for (const name of images.names) rmSync(join(dirs.photos, name), { force: true })
      deleted = images.names.every((name) => !existsSync(join(dirs.photos, name)))
    } catch {
      deleted = false
    }
    const report = contentFreeReport({ appReport, images, args, deleted })
    writeFileSync(join(out, 'owner-camera.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(join(out, 'SHA256SUMS.txt'), `${expected}  ${basename(dmg)}\n`, { mode: 0o600 })
    if (report.result === 'PRECONDITION') return 78
    return report.result === 'PASS' ? 0 : 1
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
