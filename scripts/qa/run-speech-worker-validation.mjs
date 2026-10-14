#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const workerLoader = join(root, 'out', 'main', 'meeting-speech-worker.js')
const workerBytecode = join(root, 'out', 'main', 'meeting-speech-worker.jsc')
if (!existsSync(workerLoader) || !existsSync(workerBytecode)) {
  throw new Error('Built speech worker loader/bytecode pair is missing.')
}
const loaderSource = readFileSync(workerLoader, 'utf8')
if (!loaderSource.includes('bytecode-loader.cjs') || !loaderSource.includes('meeting-speech-worker.jsc')) {
  throw new Error('Built speech worker loader does not resolve its matching bytecode sibling.')
}

const executable =
  process.platform === 'win32'
    ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(root, 'node_modules', 'electron', 'dist', 'electron')
if (!existsSync(executable)) throw new Error('Pinned Electron host executable is missing.')

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  METIS_SPEECH_ACTUAL_WORKER: '1'
}
const testFiles = [
  'src/main/transcripts.speech-provenance.test.ts',
  'src/main/features/meetings/speech-provenance.test.ts',
  'src/main/transcripts.speech-resources.test.ts',
  'src/main/features/meetings/legacy-transcript.test.ts',
  'src/main/recap-status.test.ts',
  'src/main/infra/process/meeting-speech-host.test.ts',
  'src/main/transcript-envelope-reader.test.ts'
]
const args = [
  resolve(root, 'node_modules/vitest/vitest.mjs'),
  'run',
  '--config',
  'vitest.config.ts',
  '--maxWorkers=2',
  ...testFiles
]
const result = spawnSync(executable, args, {
  cwd: root,
  env,
  stdio: 'inherit',
  timeout: 35 * 60 * 1000,
  windowsHide: true
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
