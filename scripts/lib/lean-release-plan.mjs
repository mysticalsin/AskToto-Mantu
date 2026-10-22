// lean-release-plan.mjs — the ordered build plan for the lean release profile (G11).
//
// Lean is the profile the 2.12 owner-channel lane builds and ships: no GGUF weights, no ASR models, no ONNX or
// llama runtimes, and no per-arch native inference payloads. The optional components (local LLM, Whisper,
// Parakeet) are described in src/main/features/components/speech-pack/optional-component-descriptors.ts and are
// offered with consent. The `full` profile stays buildable on purpose, for 1.9.x hotfixes and legacy comparison;
// it is selected only by its own chains (dist, dist:local, dist:win, release*), never by this plan.
//
// Every step runs through scripts/lean-release.mjs, so the QA lane, the lean-candidates lane and a maintainer
// run the same commands in the same order. The plan is pure data: tests pin it, nothing here spawns a process.
import { posix } from 'node:path'

/** The package profile every release candidate is built with. A full package is a legacy, explicit opt-in. */
export const RELEASE_PACKAGE_PROFILE = 'lean'

const TARGETS = ['mac', 'win']
const ARCHES = ['arm64', 'x64']
const RELEASE_DIR = 'release'
const INSTALLER_PATTERN = '\\.(dmg|zip|exe)$'

function node(name, script, args = [], env) {
  return { name, command: 'node', args: [script, ...args], ...(env ? { env } : {}) }
}

/** @returns {{ target: 'mac'|'win', arch: 'arm64'|'x64', qaIdentity: boolean, dryRun: boolean }} */
export function parseLeanReleaseArgs(argv) {
  const [target, arch, ...options] = argv
  if (!TARGETS.includes(target)) throw new Error(`The lean release target must be mac or win; got ${String(target)}`)
  if (!ARCHES.includes(arch)) throw new Error(`The lean release architecture must be arm64 or x64; got ${String(arch)}`)
  if (target === 'win' && arch !== 'x64') throw new Error('Lean Windows packages are x64 only')
  let qaIdentity = false
  let dryRun = false
  for (const option of options) {
    if (option === '--qa-identity') qaIdentity = true
    else if (option === '--dry-run') dryRun = true
    else throw new Error(`Unknown option: ${option}`)
  }
  if (qaIdentity && target !== 'mac') throw new Error('The QA identity variant exists for macOS only')
  if (qaIdentity && arch !== 'arm64') {
    // Metis-QA-<version>.zip carries no architecture, so only one arch can ship under that name.
    throw new Error('The QA identity variant is built for arm64 only')
  }
  return { target, arch, qaIdentity, dryRun }
}

/**
 * @param {{ target: 'mac'|'win', arch: 'arm64'|'x64', qaIdentity?: boolean, hostArch?: string }} options
 * @returns {{ outputDir: string, appDir: string, steps: object[] }}
 */
export function leanReleasePlan({ target, arch, qaIdentity = false, hostArch = process.arch }) {
  parseLeanReleaseArgs([target, arch, ...(qaIdentity ? ['--qa-identity'] : [])])
  const mac = target === 'mac'
  const outputDir = posix.join(RELEASE_DIR, `lean-${target}-${arch}`)
  // electron-builder names the unpacked app directory by architecture: mac-arm64 for arm64, plain `mac` for x64.
  const appDir = mac ? posix.join(outputDir, arch === 'arm64' ? 'mac-arm64' : 'mac') : outputDir
  const profile = { METIS_PACKAGE_PROFILE: RELEASE_PACKAGE_PROFILE }
  const archPin = { ...profile, METIS_PACKAGE_ARCH: arch }
  // V8 bytecode is architecture-bound (MQA-207). The one place an installer is built for an architecture other
  // than the build host's, the build compiles without it, as the universal chains do, so it cannot ship a
  // code cache the target CPU rejects.
  const crossArch = arch !== hostArch
  const buildEnv = {
    ...profile,
    ...(qaIdentity ? { METIS_QA_IDENTITY: '1' } : {}),
    ...(crossArch ? { ASKTOTO_MAC_UNIVERSAL: '1' } : {})
  }

  const builderArgs = mac
    ? [
        'electron-builder',
        ...(qaIdentity
          ? ['--config', 'build/qa-identity.electron-builder.yml', '--mac', 'zip']
          : ['--mac', 'dmg', 'zip']),
        `--${arch}`,
        '--publish',
        'never',
        '-c.npmRebuild=false',
        '-c.electronDist=resources/electron-dist',
        '-c.mac.identity=null',
        `-c.directories.output=${outputDir}`,
        ...(qaIdentity ? [] : ['-c.mac.artifactName=Metis-${version}-${arch}.${ext}'])
      ]
    : [
        'electron-builder',
        '--config',
        'electron-builder.win.yml',
        '--win',
        'nsis',
        'portable',
        '--x64',
        '--publish',
        'never',
        '-c.npmRebuild=false',
        `-c.directories.output=${outputDir}`
      ]

  const steps = [
    node('Embed the Cloudflare key (when authorised)', 'scripts/embed-cloudflare-key.mjs'),
    node(
      'Embed the Operator enrolment blob (when a token is provided)',
      'scripts/embed-operator-enroll-token.mjs',
      qaIdentity ? ['--qa'] : []
    ),
    node('Validate the embedded Cloudflare key', 'scripts/check-cloudflare-key-valid.mjs'),
    ...(mac
      ? [
          node('Check the reviewed FFmpeg decoder', 'scripts/check-ffmpeg-sidecar.mjs', ['mac', arch]),
          node('Provision the Electron distribution', 'scripts/provision-electron-dist.mjs', [arch]),
          node('Build the capture helper', 'scripts/build-mac-helper.mjs'),
          node('Check the capture helper', 'scripts/check-mac-helper.mjs', ['mac']),
          node('Provision managed Node', 'scripts/fetch-managed-node.mjs', ['mac'])
        ]
      : [
          node('Check the reviewed FFmpeg decoder', 'scripts/check-ffmpeg-sidecar.mjs', ['win', 'x64']),
          node('Provision managed Node and the VC++ runtime', 'scripts/fetch-managed-node.mjs', ['win'])
        ]),
    { name: 'Build the Intelligence bundle', command: 'npm', args: ['run', 'build:intelligence'] },
    { name: 'Compile the lean application', command: 'npm', args: ['run', 'build'], env: buildEnv },
    {
      name: `Package the lean ${target} ${arch} installers`,
      command: 'npx',
      args: builderArgs,
      env: {
        ...archPin,
        ...(mac ? { ASKTOTO_ADHOC_SIGN: '1' } : {}),
        ...(qaIdentity ? { METIS_QA_IDENTITY: '1' } : {})
      }
    },
    node('Check the embedded Cloudflare key in the package', 'scripts/check-embedded-cloudflare-key.mjs', [appDir]),
    node('Check the embedded enrolment blob in the package', 'scripts/check-embedded-operator-enroll.mjs', [appDir]),
    // The QA identity build ships a zip only; the measurement reads the unsigned DMG or Setup it was written for.
    ...(qaIdentity
      ? []
      : [node('Measure the installer and app tree', 'scripts/measure-lean-candidate.mjs', [target, arch, outputDir])]),
    {
      name: 'Move the installers to the release directory',
      collect: { from: outputDir, to: RELEASE_DIR, pattern: INSTALLER_PATTERN }
    }
  ]
  return { outputDir, appDir, steps }
}

/** One readable line per step, with its environment, for logs and for tests that pin the order. */
export function formatStep(step) {
  if (step.collect) return `collect ${step.collect.from} -> ${step.collect.to} /${step.collect.pattern}/`
  const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value}`)
  return [...env, step.command, ...step.args].join(' ')
}
