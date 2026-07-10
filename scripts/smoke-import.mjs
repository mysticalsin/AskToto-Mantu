#!/usr/bin/env node
/**
 * Production-path smoke test for an imported recording. It launches the built Electron app, gives the
 * native picker a bundled WAV, and waits for the public IPC job view to finish. This intentionally
 * covers the hidden decoder, chunk IPC, on-device Parakeet, durable meeting save, and recap fallback.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const fixture = join(root, 'resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/test_wavs/en.wav')
const packagedExecutable = process.env.ASKTOTO_SMOKE_EXECUTABLE ? resolve(process.env.ASKTOTO_SMOKE_EXECUTABLE) : null
if (!packagedExecutable && !existsSync(join(root, 'out/main/index.js'))) {
  throw new Error('Build the app first: npm run build')
}
if (packagedExecutable && !existsSync(packagedExecutable)) throw new Error(`Missing packaged executable: ${packagedExecutable}`)
if (!existsSync(fixture)) throw new Error(`Missing bundled audio fixture: ${fixture}`)

const userData = mkdtempSync(join(tmpdir(), 'asktoto-import-smoke-'))
// Electron does not honor --user-data-dir for app.getPath('userData'); the app's real isolation hook is
// the ASKTOTO_USERDATA env var (src/main/index.ts), so isolate the smoke test's profile through that
// instead of the flag, which would otherwise silently run against the developer's real profile.
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ASKTOTO_USERDATA: userData }
let app
try {
  app = await electron.launch(packagedExecutable
    ? { executablePath: packagedExecutable, env }
    : { args: [root], env })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.toto, undefined, { timeout: 30_000 })

  await app.evaluate(async ({ dialog }, pickedFile) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [pickedFile] })
    })
  }, fixture)

  const started = await page.evaluate(async () => {
    const picked = await window.toto.importAudioPick()
    if (!picked.token) throw new Error(picked.error || 'No single-use import capability was returned.')
    return window.toto.importAudioStart(picked.token)
  })
  if (!started?.jobId) throw new Error('Import did not return a job ID.')

  // Stronger than closing Recall: the initiating renderer is rebuilt entirely while the main-process
  // job and isolated decoder continue. The new renderer observes the same durable job via public IPC.
  await page.reload()
  await page.waitForFunction(() => !!window.toto, undefined, { timeout: 30_000 })

  const deadline = Date.now() + 120_000
  let job = started
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    job = await page.evaluate(async (jobId) => (await window.toto.importJobsList()).find((entry) => entry.jobId === jobId), started.jobId)
    if (job?.state === 'done') break
    if (job?.state === 'failed') throw new Error(job.error || 'The import job failed.')
  }
  if (job?.state !== 'done' || !job.file) throw new Error('Import did not finish within two minutes.')

  const meeting = await page.evaluate(async (file) => window.toto.recallRead(file), job.file)
  if (!meeting?.ok || !meeting.lines?.length) throw new Error('The imported meeting was not saved with transcript lines.')
  console.log(`[smoke-import] PASS ${job.file} (${meeting.lines.length} transcript lines)`)
} finally {
  await app?.close().catch(() => {})
  rmSync(userData, { recursive: true, force: true })
}
