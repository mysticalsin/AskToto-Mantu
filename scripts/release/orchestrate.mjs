#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_ALIASES = new Map([
  ['release', 'mac'],
  ['release:build:mac', 'mac'],
  ['release:win', 'win'],
  ['release:build:win', 'win'],
  ['release:mas', 'mas'],
  ['release:win:store', 'win-store']
])

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electronBuilder = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'

function nodeScript(script, args = [], options = {}) {
  return {
    name: options.name ?? script.replace(/^scripts\//, '').replace(/\.mjs$/, ''),
    command: process.execPath,
    args: [script, ...args],
    env: options.env
  }
}

function npmRun(script, options = {}) {
  return {
    name: options.name ?? `npm run ${script}`,
    command: npm,
    args: ['run', script],
    env: options.env
  }
}

function buildTool(args, options = {}) {
  return {
    name: options.name ?? 'electron-builder',
    command: electronBuilder,
    args,
    env: options.env
  }
}

function releasePrerequisites(platform) {
  const mac = platform === 'mac'
  return [
    ...(platform === 'win' ? [nodeScript('scripts/check-build-host.mjs', ['win'], { name: 'Check Windows build host' })] : []),
    nodeScript('scripts/embed-cloudflare-key.mjs', [], { name: 'Embed Cloudflare key' }),
    nodeScript('scripts/check-cloudflare-key-valid.mjs', [], { name: 'Validate embedded Cloudflare key' }),
    ...(mac
      ? [
          nodeScript('scripts/check-ffmpeg-sidecar.mjs', ['mac', 'arm64'], { name: 'Check mac arm64 ffmpeg sidecar' }),
          nodeScript('scripts/check-ffmpeg-sidecar.mjs', ['mac', 'x64'], { name: 'Check mac x64 ffmpeg sidecar' }),
          nodeScript('scripts/provision-mac-natives.mjs', [], { name: 'Provision mac natives' }),
          nodeScript('scripts/check-sherpa-platform.mjs', ['mac', 'arm64'], { name: 'Check mac arm64 Sherpa' }),
          nodeScript('scripts/check-sherpa-platform.mjs', ['mac', 'x64'], { name: 'Check mac x64 Sherpa' }),
          nodeScript('scripts/provision-electron-dist.mjs', [], { name: 'Provision Electron distribution' }),
          nodeScript('scripts/fetch-llama-server.mjs', ['mac'], { name: 'Fetch mac llama sidecar' }),
          nodeScript('scripts/check-llama-sidecar.mjs', ['mac'], { name: 'Check mac llama sidecar' }),
          nodeScript('scripts/build-mac-helper.mjs', [], { name: 'Build mac helper' }),
          nodeScript('scripts/check-mac-helper.mjs', ['mac'], { name: 'Check mac helper' })
        ]
      : [
          nodeScript('scripts/check-ffmpeg-sidecar.mjs', ['win'], { name: 'Check Windows ffmpeg sidecar' }),
          nodeScript('scripts/check-sherpa-platform.mjs', ['win'], { name: 'Check Windows Sherpa' }),
          nodeScript('scripts/fetch-llama-server.mjs', ['win'], { name: 'Fetch Windows llama sidecar' }),
          nodeScript('scripts/check-llama-sidecar.mjs', ['win'], { name: 'Check Windows llama sidecar' })
        ]),
    nodeScript('scripts/fetch-managed-node.mjs', [platform], { name: 'Fetch managed Node' }),
    nodeScript('scripts/fetch-local-model.mjs', [], { name: 'Fetch local model' }),
    nodeScript('scripts/check-local-model.mjs', [], { name: 'Check local model' }),
    ...(mac ? [npmRun('check:xcode', { name: 'Check Xcode tools' })] : []),
    nodeScript('scripts/check-release-secrets.mjs', [platform], { name: `Check ${platform} release secrets` }),
    nodeScript('scripts/check-provisioned-secrets.mjs', ['--profile', 'release'], { name: 'Check provisioned release secrets' }),
    npmRun('check:release', { name: 'Check release metadata' }),
    nodeScript('scripts/fetch-speaker-model.mjs', [], { name: 'Fetch speaker model' }),
    nodeScript('scripts/fetch-models.mjs', [], { name: 'Fetch ASR models' }),
    npmRun('build:intelligence', { name: 'Build Intelligence bundle' })
  ]
}

const releasePlans = {
  mac: [
    ...releasePrerequisites('mac'),
    npmRun('build', { name: 'Build desktop app', env: { ASKTOTO_MAC_UNIVERSAL: '1' } }),
    buildTool(['--mac', '--universal', '-c.npmRebuild=false', '-c.electronDist=resources/electron-dist', '--publish', 'never'], {
      name: 'Package mac universal app',
      env: { ASKTOTO_MAC_ARCHES: 'arm64,x64' }
    }),
    nodeScript('scripts/check-packaged-runtime.mjs', ['mac', '--arches=arm64,x64', '--macho-arches=arm64,x64', '--post-sign'], {
      name: 'Check mac packaged runtime'
    }),
    nodeScript('scripts/check-update-metadata.mjs', ['release/latest-mac.yml'], { name: 'Check mac update metadata' }),
    nodeScript('scripts/verify-signing.mjs', ['--require-notarized'], { name: 'Verify mac signing and notarization' }),
    nodeScript('scripts/check-packaged-launch.mjs', ['release/mac-universal/Metis.app'], {
      name: 'Launch mac package',
      env: { ASKTOTO_MAC_LAUNCH_GATE: '1' }
    }),
    nodeScript('scripts/check-embedded-cloudflare-key.mjs', ['release/mac-universal'], { name: 'Check embedded key in mac package' })
  ],
  win: [
    ...releasePrerequisites('win'),
    npmRun('build', { name: 'Build desktop app' }),
    buildTool(['--config', 'electron-builder.win.yml', '--win', '--x64', '--publish', 'never'], { name: 'Package Windows app' }),
    nodeScript('scripts/check-packaged-runtime.mjs', ['win', '--post-sign'], { name: 'Check Windows packaged runtime' }),
    nodeScript('scripts/check-update-metadata.mjs', ['release/latest.yml'], { name: 'Check Windows update metadata' }),
    nodeScript('scripts/verify-signing.mjs', [], { name: 'Verify Windows signing' }),
    nodeScript('scripts/check-packaged-launch.mjs', ['release/win-unpacked/Metis.exe'], { name: 'Launch Windows package' }),
    nodeScript('scripts/check-packaged-asr.mjs', [], { name: 'Check Windows packaged ASR' }),
    nodeScript('scripts/check-embedded-cloudflare-key.mjs', ['release'], { name: 'Check embedded key in Windows package' })
  ],
  mas: [
    nodeScript('scripts/check-ffmpeg-sidecar.mjs', ['mac', 'arm64'], { name: 'Check MAS ffmpeg sidecar' }),
    nodeScript('scripts/check-sherpa-platform.mjs', ['mac', 'arm64'], { name: 'Check MAS Sherpa' }),
    nodeScript('scripts/provision-electron-dist.mjs', ['--platform=mas', 'arm64'], { name: 'Provision MAS Electron distribution' }),
    nodeScript('scripts/fetch-llama-server.mjs', ['mac'], { name: 'Fetch mac llama sidecar' }),
    nodeScript('scripts/check-llama-sidecar.mjs', ['mac'], { name: 'Check mac llama sidecar' }),
    nodeScript('scripts/build-mac-helper.mjs', [], { name: 'Build mac helper' }),
    nodeScript('scripts/check-mac-helper.mjs', ['mac'], { name: 'Check mac helper' }),
    nodeScript('scripts/fetch-local-model.mjs', [], { name: 'Fetch local model' }),
    nodeScript('scripts/check-local-model.mjs', [], { name: 'Check local model' }),
    npmRun('check:xcode', { name: 'Check Xcode tools' }),
    nodeScript('scripts/check-release-secrets.mjs', ['mas'], { name: 'Check MAS release secrets' }),
    nodeScript('scripts/check-provisioned-secrets.mjs', ['--profile', 'release'], { name: 'Check provisioned release secrets' }),
    nodeScript('scripts/fetch-speaker-model.mjs', [], { name: 'Fetch speaker model' }),
    nodeScript('scripts/fetch-models.mjs', [], { name: 'Fetch ASR models' }),
    npmRun('build:intelligence', { name: 'Build Intelligence bundle' }),
    npmRun('build', { name: 'Build desktop app' }),
    buildTool(['--mac', 'mas', '--arm64', '-c.electronDist=resources/electron-dist', '--publish', 'never', `-c.mas.provisioningProfile=${process.env.MAS_PROVISIONING_PROFILE ?? ''}`], {
      name: 'Package MAS app'
    })
  ],
  'win-store': [
    nodeScript('scripts/check-ffmpeg-sidecar.mjs', ['win'], { name: 'Check Windows ffmpeg sidecar' }),
    nodeScript('scripts/check-sherpa-platform.mjs', ['win'], { name: 'Check Windows Sherpa' }),
    nodeScript('scripts/fetch-llama-server.mjs', ['win'], { name: 'Fetch Windows llama sidecar' }),
    nodeScript('scripts/check-llama-sidecar.mjs', ['win'], { name: 'Check Windows llama sidecar' }),
    nodeScript('scripts/fetch-local-model.mjs', [], { name: 'Fetch local model' }),
    nodeScript('scripts/check-local-model.mjs', [], { name: 'Check local model' }),
    nodeScript('scripts/check-release-secrets.mjs', ['win-store'], { name: 'Check Windows Store release secrets' }),
    nodeScript('scripts/check-provisioned-secrets.mjs', ['--profile', 'release'], { name: 'Check provisioned release secrets' }),
    nodeScript('scripts/fetch-speaker-model.mjs', [], { name: 'Fetch speaker model' }),
    nodeScript('scripts/fetch-models.mjs', [], { name: 'Fetch ASR models' }),
    npmRun('build:intelligence', { name: 'Build Intelligence bundle' }),
    npmRun('build', { name: 'Build desktop app' }),
    buildTool(['--config', 'electron-builder.win.yml', '--win', 'appx', '--x64', '--publish', 'never', '-c.directories.output=release-appx'], {
      name: 'Package Windows Store app'
    })
  ]
}

function usage() {
  return [
    'Usage: node scripts/release/orchestrate.mjs [mac|win|mas|win-store] [--dry-run]',
    `Targets: ${Object.keys(releasePlans).join(', ')}`,
    'Use --script-name <npm-script> to resolve package.json release aliases.'
  ].join('\n')
}

function parseArgs(argv) {
  let target = null
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--script-name') {
      const scriptName = argv[index + 1]
      if (!scriptName) throw new Error('--script-name requires an npm script name')
      target = SCRIPT_ALIASES.get(scriptName)
      if (!target) throw new Error(`Unknown release script: ${scriptName}`)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, dryRun, target: 'mac' }
    } else if (!target) {
      target = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  target ??= 'mac'
  if (!releasePlans[target]) throw new Error(`Unknown release target: ${target}`)
  return { help: false, dryRun, target }
}

function formatCommand(step) {
  const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value}`)
  return [...env, step.command, ...step.args].join(' ')
}

function formatStepResult({ index, total, name, exitCode, durationMs, command, dryRun }) {
  const status = dryRun ? 'dry-run' : exitCode === 0 ? 'ok' : 'failed'
  return `[release:${status}] step=${index}/${total} name="${name}" exitCode=${exitCode} durationMs=${durationMs} command="${command}"`
}

function runStep(step, env, runner = spawn) {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = runner(step.command, step.args, {
      env: { ...env, ...(step.env ?? {}) },
      shell: false,
      stdio: 'inherit'
    })
    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        durationMs: Math.round(performance.now() - started),
        error
      })
    })
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code ?? 1,
        signal,
        durationMs: Math.round(performance.now() - started)
      })
    })
  })
}

async function runPlan(target, options = {}) {
  const steps = releasePlans[target]
  if (!steps) throw new Error(`Unknown release target: ${target}`)
  const log = options.log ?? console.log
  const env = options.env ?? process.env
  const runner = options.runner ?? spawn

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const command = formatCommand(step)
    if (options.dryRun) {
      log(formatStepResult({
        index: index + 1,
        total: steps.length,
        name: step.name,
        exitCode: 'not-run',
        durationMs: 0,
        command,
        dryRun: true
      }))
      continue
    }

    log(`[release:start] step=${index + 1}/${steps.length} name="${step.name}" command="${command}"`)
    const result = await runStep(step, env, runner)
    log(formatStepResult({
      index: index + 1,
      total: steps.length,
      name: step.name,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      command,
      dryRun: false
    }))
    if (result.error) {
      console.error(`[release:error] ${result.error.message}`)
      return result.exitCode
    }
    if (result.signal) {
      console.error(`[release:error] step "${step.name}" terminated by signal ${result.signal}`)
      return result.exitCode
    }
    if (result.exitCode !== 0) return result.exitCode
  }

  return 0
}

async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseArgs(argv)
    if (parsed.help) {
      console.log(usage())
      return 0
    }
    return await runPlan(parsed.target, { dryRun: parsed.dryRun })
  } catch (error) {
    console.error(error.message)
    console.error(usage())
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await main()
  process.exitCode = code
}

export { formatCommand, formatStepResult, main, parseArgs, releasePlans, runPlan }
