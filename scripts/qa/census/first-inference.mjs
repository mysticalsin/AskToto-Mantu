#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { listProcesses, ownedProcesses } from '../owned-processes.mjs'
import { resolveInstallTarget, resolveProductVersion, writeJson } from './lib.mjs'
import { launchOptions } from './run.mjs'

export const FIRST_INFERENCE_STATE = 'first-inference'
export const DEFAULT_SECONDS = 300
export const DEFAULT_START_TIMEOUT_MS = 120_000

const PREWARM_TEXT = 'resource census first-inference proof'
const ASK_PAYLOAD = Object.freeze({
  mode: 'suggest',
  providerOverride: 'local',
  prompt: '',
  transcript: 'THEM: synthetic local inference proof',
  history: []
})

function askCompletionExpression({ id, prewarm = false }) {
  return `(() => new Promise((resolve, reject) => {
    const id = ${JSON.stringify(id)};
    let sawToken = false;
    let timer = null;
    const cleanup = [];
    const finish = (value) => {
      if (timer) clearTimeout(timer);
      while (cleanup.length) {
        try { cleanup.pop()(); } catch {}
      }
      resolve(value);
    };
    const fail = (error) => {
      if (timer) clearTimeout(timer);
      while (cleanup.length) {
        try { cleanup.pop()(); } catch {}
      }
      reject(error);
    };
    cleanup.push(window.toto.onDelta((d) => {
      if (d && d.id === id && typeof d.text === 'string' && d.text.length > 0) sawToken = true;
    }));
    cleanup.push(window.toto.onDone((d) => {
      if (!d || d.id !== id) return;
      if (!sawToken) fail(new Error('local suggest completed before a first token was seen'));
      else finish({ firstTokenSeen: true });
    }));
    cleanup.push(window.toto.onError((d) => {
      if (d && d.id === id) fail(new Error(String(d.message || 'local suggest failed')));
    }));
    timer = setTimeout(() => fail(new Error('local suggest timed out before completion')), 120000);
    Promise.resolve()
      .then(() => ${prewarm ? `window.toto.localPrewarm(${JSON.stringify(PREWARM_TEXT)}, 'summary')` : 'undefined'})
      .then(() => window.toto.ask(${JSON.stringify({ ...ASK_PAYLOAD, id })}))
      .catch(fail);
  }))()`
}

export const START_PATHS = Object.freeze([
  {
    name: 'window.toto.localPrewarm',
    timeoutMs: 90_000,
    evaluate: () => askCompletionExpression({ id: `resource-census-prewarm-${Date.now()}`, prewarm: true })
  },
  {
    name: 'window.toto.ask (suggest, local route)',
    timeoutMs: 120_000,
    evaluate: () => askCompletionExpression({ id: `resource-census-ask-${Date.now()}`, prewarm: false })
  }
])

const CONTENT_FREE_REDACTIONS = [
  PREWARM_TEXT,
  ASK_PAYLOAD.transcript,
  ASK_PAYLOAD.prompt
].filter(Boolean)

export function contentFreeErrorMessage(error) {
  let message = String(error?.message ?? error ?? 'start path refused')
  for (const text of CONTENT_FREE_REDACTIONS) {
    message = message.replaceAll(text, '[redacted]')
  }
  message = message
    .replaceAll(/\/Users\/[^\s"'`]+/g, '[path]')
    .replaceAll(/\/home\/[^\s"'`]+/g, '[path]')
    .replaceAll(/\/private\/[^\s"'`]+/g, '[path]')
    .replaceAll(/\/tmp\/[^\s"'`]+/g, '[path]')
    .replaceAll(/\/var\/folders\/[^\s"'`]+/g, '[path]')
    .replaceAll(/[A-Za-z]:\\[^\s"'`]+/g, '[path]')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return message || 'start path refused'
}

export function refusedStartPathEvidence(pathName, error) {
  return `${pathName} (${contentFreeErrorMessage(error)})`
}

function usage() {
  return `Usage:
  node scripts/qa/census/first-inference.mjs --app <installed Metis.app|Metis.exe> --profile <profile> --output <json> [--seconds 300]

Runs only in CI against an installed packaged app. It starts the bundled model through the app's own renderer path,
then attaches scripts/qa/census/run.mjs with --state first-inference. If the model start path is refused, it writes
a NOT_MEASURED PRECONDITION artifact and exits 0 so the other census states remain usable.
`
}

function readArgs(argv) {
  const args = { seconds: DEFAULT_SECONDS, startTimeoutMs: DEFAULT_START_TIMEOUT_MS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--app') args.app = next()
    else if (arg === '--profile') args.profile = next()
    else if (arg === '--output') args.output = next()
    else if (arg === '--seconds') args.seconds = Number(next())
    else if (arg === '--start-timeout-ms') args.startTimeoutMs = Number(next())
    else if (arg === '--product-version') args.productVersion = next()
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  await new Promise((resolvePromise) => server.close(resolvePromise))
  if (!address || typeof address === 'string') throw new Error('could not allocate a loopback port')
  return address.port
}

export function launchEnv(baseEnv, profile) {
  return {
    ...launchOptions({
      env: { ...baseEnv, METIS_QA_HOST_FLOOR_OVERRIDE: '1' },
      profile,
      port: null
    }).env,
    METIS_QA_HOST_FLOOR_OVERRIDE: '1'
  }
}

export function runPreconditionEvidence(control) {
  if (control?.status !== 'PASS') throw new Error('first-inference census requires a completed local inference control')
  return `start path: ${control.path}; first token seen: ${control.firstTokenSeen ? 'yes' : 'no'}`
}

export function preconditionReport({ platform, productVersion, seconds, mainPid, reason, refused, hostFloorOverride = true }) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ticket: 'M2-0562',
    evidenceLevel: 'PRECONDITION',
    productVersion,
    platform,
    state: FIRST_INFERENCE_STATE,
    seconds,
    mainPid: mainPid ?? null,
    profileKind: 'representative-synthetic',
    status: 'NOT_MEASURED',
    statePrecondition: {
      required: true,
      status: 'PRECONDITION',
      reason,
      refusedStartPaths: refused
    },
    hostFloorOverride,
    hostMemoryBytes: totalmem()
  }
}

function llamaRunning({ mainPid, installRoot, platform }) {
  return ownedProcesses(listProcesses(platform), { mainPid, installRoot, platform }).some((entry) => {
    const role = String(entry.role ?? '').toLowerCase()
    const exe = String(entry.exe ?? '').toLowerCase()
    return role === 'llama-server' || role === 'llama-server.exe' || exe.includes('llama-server')
  })
}

async function overlayPage(port, timeoutMs, connectOverCDP) {
  const connect =
    connectOverCDP ??
    (async (url, options) => {
      const { chromium } = await import('playwright')
      return chromium.connectOverCDP(url, options)
    })
  const browser = await connect(`http://127.0.0.1:${port}`, { timeout: timeoutMs })
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          try {
            if (await page.evaluate(() => typeof window.toto !== 'undefined')) return { browser, page }
          } catch {
            // The page can reload while the app is becoming ready.
          }
        }
      }
      await sleep(500)
    }
    await browser.close().catch(() => {})
    return { browser: null, page: null }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

export async function startFirstInference({ port, mainPid, installRoot, platform, connectOverCDP, now = Date.now }) {
  const refused = []
  const found = await overlayPage(port, 30_000, connectOverCDP)
  if (!found.page) return { status: 'PRECONDITION', reason: 'renderer bridge unreachable', refused }
  try {
    for (const path of START_PATHS) {
      const startedAt = now()
      try {
        const completion = await found.page.evaluate(path.evaluate())
        if (completion?.firstTokenSeen !== true) throw new Error('local suggest did not report a first token')
      } catch (error) {
        refused.push(refusedStartPathEvidence(path.name, error))
        continue
      }
      const deadline = now() + path.timeoutMs
      while (now() < deadline) {
        if (llamaRunning({ mainPid, installRoot, platform })) {
          return {
            status: 'PASS',
            path: path.name,
            firstTokenSeen: true,
            refused,
            llamaObservedMs: now() - startedAt
          }
        }
        await sleep(500)
      }
      refused.push(path.name)
    }
  } finally {
    await found.browser?.close().catch(() => {})
  }
  return { status: 'PRECONDITION', reason: 'no app start path completed local inference', refused }
}

function runCensus({ output, seconds, mainPid, installRoot, productVersion, evidence }) {
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync(
    process.execPath,
    [
      'scripts/qa/census/run.mjs',
      '--state',
      FIRST_INFERENCE_STATE,
      '--seconds',
      String(seconds),
      '--main-pid',
      String(mainPid),
      '--install-root',
      installRoot,
      '--product-version',
      productVersion,
      '--precondition-evidence',
      evidence,
      '--output',
      output
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  )
  if (result.status !== 0) {
    writeFileSync(`${output}.stderr.txt`, result.stderr ?? '', 'utf8')
    writeFileSync(`${output}.stdout.txt`, result.stdout ?? '', 'utf8')
    throw new Error(`first-inference census failed with exit ${result.status ?? 'signal'}`)
  }
}

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  if (!args.app) throw new Error('--app is required')
  if (!args.profile) throw new Error('--profile is required')
  if (!args.output) throw new Error('--output is required')
  if (!(args.seconds > 0)) throw new Error('--seconds must be positive')
  if (!existsSync(args.profile)) throw new Error(`profile does not exist: ${args.profile}`)

  const platform = process.platform
  const target = resolveInstallTarget(args.app, platform)
  const productVersion = resolveProductVersion({
    explicit: args.productVersion,
    installRoot: target.installRoot,
    executable: target.executable,
    platform
  })
  const port = await freeLoopbackPort()
  const child = spawn(target.executable, [`--remote-debugging-port=${port}`], {
    env: launchEnv(process.env, resolve(args.profile)),
    stdio: 'ignore'
  })
  const mainPid = child.pid ?? null
  if (!mainPid) throw new Error('launched app did not expose a pid')

  try {
    const control = await startFirstInference({ port, mainPid, installRoot: target.installRoot, platform })
    if (control.status !== 'PASS') {
      writeJson(
        args.output,
        preconditionReport({
          platform,
          productVersion,
          seconds: args.seconds,
          mainPid,
          reason: control.reason,
          refused: control.refused,
          hostFloorOverride: true
        })
      )
      console.log(`[first-inference] PRECONDITION: ${control.reason}`)
      return
    }
    runCensus({
      output: args.output,
      seconds: args.seconds,
      mainPid,
      installRoot: target.installRoot,
      productVersion,
      evidence: runPreconditionEvidence(control)
    })
    console.log(`[first-inference] wrote ${args.output}`)
  } finally {
    if (!child.killed) child.kill()
  }
}

export function isMainModule(metaUrl, argv1) {
  return Boolean(argv1) && metaUrl === pathToFileURL(resolve(argv1)).href
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error(`[first-inference] ${error?.message ?? error}`)
    process.exitCode = 1
  })
}
