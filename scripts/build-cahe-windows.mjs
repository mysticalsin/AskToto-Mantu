#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const outputDirectory = resolve(process.env.METIS_CAHE_INSTALLER_OUTPUT_DIR || join('release', 'cahe-win'))

if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) {
  throw new Error(
    `Refusing to overwrite a non-empty Cahê output directory: ${outputDirectory}. Use a new directory or remove its contents deliberately.`
  )
}
mkdirSync(outputDirectory, { recursive: true })

const environment = { ...process.env, METIS_CAHE_EDITION: '1' }
function run(command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd: process.cwd(), env: environment, stdio: 'inherit' })
}

run('node', ['scripts/check-no-dynamic-import.mjs'])
run('node', ['scripts/check-ffmpeg-sidecar.mjs', 'win', 'x64'])
run('node', ['scripts/check-sherpa-platform.mjs', 'win', 'x64'])
run('node', ['scripts/fetch-llama-server.mjs', 'win'])
run('node', ['scripts/check-llama-sidecar.mjs', 'win'])
run('node', ['scripts/fetch-local-model.mjs'])
run('node', ['scripts/check-local-model.mjs'])
run('node', ['scripts/fetch-models.mjs'])
run('npm', ['run', 'build:intelligence'])
run('npm', ['run', 'build'])
run('npx', [
  'electron-builder',
  '--config',
  'electron-builder.cahe.win.yml',
  '--win',
  'nsis',
  '--x64',
  '--publish',
  'never',
  `-c.directories.output=${outputDirectory}`
])
run('node', [
  'scripts/check-packaged-runtime.mjs',
  'win',
  join(outputDirectory, 'win-unpacked', 'resources'),
  '--post-sign',
  '--executable=Metis-Windows-Cahe.exe'
])
run('node', ['scripts/check-cahe-package.mjs', outputDirectory])

console.log(`\nCahê installer ready: ${outputDirectory}`)
