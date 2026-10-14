#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const electronCase = 'scripts/qa/fixtures/import-legacy-checkpoint-reader.integration.electron-case.ts'
const loader = join(root, 'out/main/import-legacy-checkpoint-worker.js')
const bytecode = join(root, 'out/main/import-legacy-checkpoint-worker.jsc')
const electron =
  process.platform === 'win32'
    ? join(root, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : join(root, 'node_modules/electron/dist/electron')
if (!existsSync(loader) || !existsSync(bytecode) || !existsSync(electron))
  throw new Error('Compiled worker pair or pinned Electron host is missing.')
const loaderSource = readFileSync(loader, 'utf8')
if (!loaderSource.includes('bytecode-loader.cjs') || !loaderSource.includes('import-legacy-checkpoint-worker.jsc'))
  throw new Error('Compiled worker loader does not resolve its bytecode sibling.')

const reportDirectory = process.env.IMPORT_LEGACY_REPORT_DIR ?? mkdtempSync(join(tmpdir(), 'metis-import-legacy-'))
mkdirSync(reportDirectory, { recursive: true })
const reportPath = join(reportDirectory, 'compiled-worker.json')
rmSync(reportPath, { force: true })
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const result = spawnSync(
  electron,
  [
    vitest,
    'run',
    '--config',
    'vitest.import-legacy-worker.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    electronCase
  ],
  {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
    windowsHide: true
  }
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Compiled worker qualification exited ${result.status ?? 'unknown'}.`)
if (!existsSync(reportPath)) throw new Error('Compiled worker report is missing.')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const results = report.testResults
const expectedAssertions = [
  'compiled Electron legacy checkpoint worker › streams one record under credit, then settles the compiled worker exactly',
  'compiled Electron legacy checkpoint worker › scans and decrypts the real ATKENC2 shape in two compiled worker passes',
  'compiled Electron legacy checkpoint worker › publishes a plain coordinator result through partial guarded reads and one-record appends',
  'compiled Electron legacy checkpoint worker › aborts a private V2 candidate when final GCM authentication fails after early record appends'
].sort()
const actualAssertions = Array.isArray(results?.[0]?.assertionResults)
  ? results[0].assertionResults
      .map((item) => [...(Array.isArray(item.ancestorTitles) ? item.ancestorTitles : []), item.title].join(' › '))
      .sort()
  : []
if (
  report.success !== true ||
  report.numTotalTests !== 4 ||
  report.numPassedTests !== 4 ||
  report.numFailedTests !== 0 ||
  report.numPendingTests !== 0 ||
  report.numTodoTests !== 0 ||
  !Array.isArray(results) ||
  results.length !== 1 ||
  actualAssertions.length !== expectedAssertions.length ||
  actualAssertions.some((name, index) => name !== expectedAssertions[index]) ||
  results[0].status !== 'passed' ||
  results[0].assertionResults?.length < 4 ||
  results[0].assertionResults?.some((item) => item.status !== 'passed') ||
  !results[0].name.replaceAll('\\', '/').endsWith(`/${electronCase}`)
)
  throw new Error('Compiled worker result is empty, incomplete, or differs from the required fixture.')
console.log('Compiled Electron legacy worker: 4/4; no failed, pending, or todo cases.')
