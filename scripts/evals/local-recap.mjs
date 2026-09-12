#!/usr/bin/env node
// Explicit opt-in entrypoint. Default npm test never starts a model.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cleanEnvironment, parseArgs, snapshotFiles, verifyBinary, writeRunConfig } from './local-recap-safety.mjs'

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.mode === 'help') {
    console.log('Local recap synthetic diagnostic (never an enterprise ship verdict).\n  --check\n  --run --binary /absolute/reviewed/llama-server --binary-sha256 <64 hex> [--temperature 0] [--trials 1..5] [--output /absolute/new-report.json] [--baseline /absolute/report.json]\n  --score /absolute/report.json\nNative runs use real production messages, budgets and spawn arguments. No automatic downloads.')
    return 0
  }
  if (options.mode === 'run') verifyBinary(options.binary, options.binarySha256)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  if (options.output && existsSync(options.output)) throw new Error('Refusing to overwrite an existing eval report; choose a new output path')
  const ownRoot = mkdtempSync(join(tmpdir(), 'metis-local-recap-eval-'))
  const profile = join(ownRoot, 'profile')
  mkdirSync(profile)
  const output = options.output ?? join(ownRoot, 'report.json')
  try {
  mkdirSync(dirname(output), { recursive: true })
  const config = { ...options, output, profile, repoRoot, gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    sourceSnapshot: snapshotFiles(repoRoot, ['src/main', 'src/shared', 'scripts/evals', 'package.json', 'package-lock.json']) }
  const child = spawn(process.execPath, [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(repoRoot, 'scripts/evals/local-recap.vitest.config.ts')], {
    cwd: repoRoot,
    env: { ...cleanEnvironment(profile), ...writeRunConfig(profile, config) },
    stdio: 'inherit'
  })
  const interrupt = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => done(code ?? 1)) })
    if (existsSync(output)) console.log(`Synthetic diagnostic report: ${output}`)
    return code
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
  } finally {
    rmSync(profile, { recursive: true, force: true })
    if (options.output || !existsSync(output)) rmSync(ownRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code }, (error) => { console.error(error.message); process.exitCode = 2 })
}
