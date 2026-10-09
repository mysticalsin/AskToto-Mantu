import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TLS_ROWS,
  TLS_RESIDUALS,
  assessHostedTlsReport,
  bindHostedTlsCandidate,
  candidateOperation,
  createAuditMonitor,
  createAuditParser,
  createEndpointLatch,
  createFixedInspector,
  createHostedTlsReport,
  fixtureToolArguments,
  hostedTlsReportProblems,
  runFixtureTool,
  verifyHostedApp
} from './hosted-candidate-tls.mjs'

const identity = {
  candidate_run: 42,
  producer_commit: 'a'.repeat(40),
  installer_sha256: 'b'.repeat(64),
  version: '1.9.7',
  harness_commit: 'c'.repeat(40),
  platform: 'darwin'
}
const provenance = () => ({
  schema: 1,
  repository: 'mysticalsin/AskToto-Mantu',
  run: { id: 42 },
  commit: identity.producer_commit,
  version: identity.version,
  builds: [
    {
      variant: 'mac-qa-identity',
      artifact: 'candidate-mac-qa-identity',
      electron: '43.6.0',
      assets: [{ name: 'Metis-QA-1.9.7.zip', size: 12, sha256: identity.installer_sha256 }]
    }
  ]
})
const context = {
  candidateRun: 42,
  producerCommit: identity.producer_commit,
  harnessCommit: identity.harness_commit,
  sha256: identity.installer_sha256,
  installer: 'assets/Metis-QA-1.9.7.zip'
}
const ready = Buffer.from('{"event":"app.renderer.ready"}\n')
const crash = Buffer.from('{"event":"app.crash"}\n')
const roots: string[] = []
const temp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-tls-unit-')))
  roots.push(root)
  return root
}
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('hosted TLS immutable support evidence', () => {
  it('binds only the one QA ZIP to independently provided run and producer commit', () => {
    expect(bindHostedTlsCandidate(provenance(), context)).toEqual(identity)
    for (const changed of [
      { ...context, candidateRun: 43 },
      { ...context, producerCommit: 'd'.repeat(40) },
      { ...context, sha256: 'e'.repeat(64) },
      { ...context, installer: 'assets/Metis-1.9.7.dmg' }
    ]) {
      expect(() => bindHostedTlsCandidate(provenance(), changed)).toThrow()
    }
  })

  it('rejects wrong repository, duplicate QA build, wrong runtime and duplicate asset', () => {
    const wrongRepo = { ...provenance(), repository: 'synthetic/other' }
    const duplicate = provenance()
    duplicate.builds.push(duplicate.builds[0])
    const runtime = provenance()
    runtime.builds[0].electron = '42.0.0'
    const asset = provenance()
    asset.builds[0].assets.push(asset.builds[0].assets[0])
    for (const value of [wrongRepo, duplicate, runtime, asset]) {
      expect(() => bindHostedTlsCandidate(value, context)).toThrow()
    }
  })

  it('requires every closed row and acknowledged cleanup for PASS, never shipping qualification', () => {
    const report = createHostedTlsReport(identity)
    expect(report.outcome).toBe('PRECONDITION')
    report.outcome = 'PASS'
    report.failure = 'none'
    report.teardown = 'ACKNOWLEDGED'
    report.cleanup = 'REMOVED'
    report.tool = { sha256: 'd'.repeat(64), version: '3.6.4', image: '20260907.0351.1', arch: 'arm64' }
    report.rows = TLS_ROWS.map((id: string) => ({ id, status: 'PASS' }))
    expect(hostedTlsReportProblems(report)).toEqual([])
    expect(assessHostedTlsReport(report, identity)).toEqual([])
    expect(report.residuals).toEqual(TLS_RESIDUALS)
    expect(hostedTlsReportProblems({ ...report, arbitrary: 'private' })).not.toEqual([])
    expect(hostedTlsReportProblems({ ...report, teardown: 'UNACKNOWLEDGED' })).not.toEqual([])
    expect(hostedTlsReportProblems({ ...report, failure: 'raw error' })).not.toEqual([])
    expect(assessHostedTlsReport(report, { ...identity, producer_commit: 'd'.repeat(40) })).not.toEqual([])
    expect(
      hostedTlsReportProblems({ ...report, outcome: 'FAIL', failure: 'network-failed', teardown: 'UNACKNOWLEDGED' })
    ).toContain('report-cleanup-invalid')
  })
})

describe('complete append-only audit records', () => {
  it('keeps incomplete ready pending and parses split UTF8 without dropping subsequent complete records', () => {
    const parser = createAuditParser()
    parser.accept(ready.subarray(0, -1))
    expect(parser.ready).toBe(false)
    parser.accept(ready)
    expect(parser.ready).toBe(true)
    const unicode = Buffer.from('{"event":"other","value":"é"}\n')
    const split = ready.length + unicode.indexOf(Buffer.from('é')) + 1
    const all = Buffer.concat([ready, unicode])
    parser.accept(all.subarray(0, split))
    parser.accept(all)
    parser.finish()
  })

  it.each(['app.crash', 'app.unresponsive'])('does not return early after ready before %s', (event) => {
    const parser = createAuditParser()
    expect(() => parser.accept(Buffer.concat([ready, Buffer.from(JSON.stringify({ event }) + '\n')]))).toThrow(
      'audit-failed'
    )
  })

  it.each([
    Buffer.from('\n'),
    Buffer.from('{bad}\n'),
    Buffer.from('[]\n'),
    Buffer.from('{"event":42}\n'),
    Buffer.alloc(65_537, 97),
    Buffer.alloc(1_048_577, 97)
  ])('rejects malformed or overflowing input', (bytes) => {
    expect(() => createAuditParser().accept(bytes)).toThrow('audit-failed')
  })

  it('rejects final tail, truncation and prefix replacement', () => {
    const tail = createAuditParser()
    tail.accept(ready.subarray(0, -1))
    expect(() => tail.finish()).toThrow('audit-failed')
    const shortened = createAuditParser()
    shortened.accept(ready)
    expect(() => shortened.accept(Buffer.alloc(0))).toThrow('audit-failed')
    const rewritten = createAuditParser()
    rewritten.accept(ready)
    expect(() => rewritten.accept(Buffer.from('{"event":"something.different"}\n'))).toThrow('audit-failed')
  })

  it('monitors real owned file identity and catches a crash on final drain', () => {
    const root = temp()
    mkdirSync(join(root, 'logs'))
    const path = join(root, 'logs', 'audit.log')
    const monitor = createAuditMonitor(root)
    expect(monitor.read()).toBe(false)
    writeFileSync(path, ready)
    expect(monitor.read()).toBe(true)
    appendFileSync(path, crash)
    expect(() => monitor.read(true)).toThrow('audit-failed')
    monitor.close()
  })

  it.each(['replacement', 'rotation', 'hardlink'])('rejects %s before accepting a new audit generation', (kind) => {
    const root = temp()
    mkdirSync(join(root, 'logs'))
    const path = join(root, 'logs', 'audit.log')
    writeFileSync(path, ready)
    const monitor = createAuditMonitor(root)
    monitor.read()
    if (kind === 'hardlink') linkSync(path, join(root, 'alias'))
    else {
      renameSync(path, join(root, 'logs', kind === 'rotation' ? 'audit-123.log' : 'old'))
      writeFileSync(path, ready)
    }
    expect(() => monitor.read(true)).toThrow('audit-failed')
    monitor.close()
  })
})

describe('inspector endpoint ownership', () => {
  const endpoint = 'ws://127.0.0.1:4321/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  it('latches the exact child stream across chunks', () => {
    const latch = createEndpointLatch()
    latch.accept(Buffer.from('Debugger list'))
    latch.accept(Buffer.from(`ening on ${endpoint}\n`))
    expect(latch.endpoint).toBe(endpoint)
  })
  it.each([
    'ws://example.invalid:4321/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'ws://127.0.0.1:0/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'ws://127.0.0.1:4321/not-a-uuid'
  ])('rejects an unowned or malformed endpoint', (value) => {
    expect(() => createEndpointLatch().accept(Buffer.from(`Debugger listening on ${value}\n`))).toThrow()
  })
  it('rejects multiple endpoints and overflow without exposing raw bytes', () => {
    const latch = createEndpointLatch()
    latch.accept(Buffer.from(`Debugger listening on ${endpoint}\n`))
    expect(() => latch.accept(Buffer.from(`Debugger listening on ${endpoint}\n`))).toThrow('inspector-failed')
    expect(() => createEndpointLatch().accept(Buffer.alloc(65_537))).toThrow('inspector-failed')
  })
})

describe('owned fixture tool settlement', () => {
  const fakeChild = () =>
    Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdout: new PassThrough(),
      stderr: null
    })
  it('pins generation arguments without a shell and requires close plus group acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const child = fakeChild()
    const spawn = vi.fn<(file: string, args: string[], options: object) => ReturnType<typeof fakeChild>>(() => child)
    const stop = vi.fn(async () => ({ state: 'acknowledged' }))
    const promise = runFixtureTool('generate', {
      cwd: '/synthetic',
      env: {},
      deadline: performance.now() + 20_000,
      spawn,
      stop
    })
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(25)
    expect(await promise).toEqual({ ok: true, cleanup: true, output: '' })
    expect(spawn.mock.calls[0]?.[1]).toEqual(fixtureToolArguments('generate'))
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      shell: false,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    expect(stop).toHaveBeenCalledWith(child, expect.anything())
  })

  it('retains uncertainty after timeout and never accepts a requested kill as acknowledgment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const child = fakeChild()
    const stop = vi.fn(async () => ({ state: 'unacknowledged', reason: 'group-still-present' }))
    const promise = runFixtureTool('version', {
      cwd: '/synthetic',
      env: {},
      deadline: performance.now() + 20_000,
      spawn: () => child,
      stop
    })
    await vi.advanceTimersByTimeAsync(20_100)
    expect(await promise).toMatchObject({ ok: false, cleanup: false, output: '' })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('bounds version output and requires close even after exit and group acknowledgment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const child = fakeChild()
    const stop = vi.fn(async () => ({ state: 'acknowledged' }))
    const promise = runFixtureTool('version', {
      cwd: '/synthetic',
      env: {},
      deadline: performance.now() + 20_000,
      spawn: () => child,
      stop
    })
    child.stdout.write(Buffer.alloc(4097))
    child.exitCode = 0
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(20_100)
    expect(await promise).toEqual({ ok: false, cleanup: false, output: '' })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it.each(['nonzero', 'signal', 'child-error', 'stream-error'])(
    'keeps %s failed after cleanup settles',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const child = fakeChild()
      const stop = vi.fn(async () => ({ state: 'acknowledged' }))
      const promise = runFixtureTool('version', {
        cwd: '/synthetic',
        env: {},
        deadline: performance.now() + 20_000,
        spawn: () => child,
        stop
      })
      child.stdout.write('private output')
      child.exitCode = kind === 'nonzero' ? 1 : 0
      child.signalCode = kind === 'signal' ? 'SIGTERM' : null
      if (kind === 'child-error') child.emit('error', new Error('private error'))
      if (kind === 'stream-error') child.stdout.emit('error', new Error('private stream error'))
      child.emit('exit', child.exitCode, child.signalCode)
      child.emit('close', child.exitCode, child.signalCode)
      await vi.advanceTimersByTimeAsync(25)
      expect(await promise).toEqual({ ok: false, cleanup: true, output: '' })
      expect(stop).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not turn a missing spawn receipt or exhausted reserve into success', async () => {
    const spawn = vi.fn(() => {
      throw new Error('private spawn failure')
    })
    const stop = vi.fn(async () => ({ state: 'unacknowledged', reason: 'invalid-pid' }))
    const options = { cwd: '/synthetic', env: {}, deadline: performance.now() + 20_000, spawn, stop }
    expect(await runFixtureTool('version', options)).toEqual({ ok: false, cleanup: false, output: '' })
    expect(stop).toHaveBeenCalledWith(null, expect.anything())
    expect(await runFixtureTool('generate', { ...options, deadline: performance.now() })).toEqual({
      ok: false,
      cleanup: true,
      output: ''
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('installed QA bundle admission', () => {
  const fixture = () => {
    const cwd = temp()
    const app = join(cwd, 'candidate-install', 'Metis QA.app')
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
    mkdirSync(join(app, 'Contents', 'Resources'))
    const executable = join(app, 'Contents', 'MacOS', 'Metis QA')
    writeFileSync(executable, 'synthetic marker, never executed', { mode: 0o755 })
    writeFileSync(join(app, 'Contents', 'Resources', 'app.asar'), 'synthetic archive')
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<plist><dict>' +
        '<key>CFBundleIdentifier</key><string>com.mantu.asktoto.qa</string>' +
        '<key>CFBundleExecutable</key><string>Metis QA</string>' +
        '<key>CFBundleShortVersionString</key><string>1.9.7</string></dict></plist>'
    )
    const installer = join(cwd, 'Metis-QA-1.9.7.zip')
    writeFileSync(installer, 'zip')
    const id = { ...identity, installer_sha256: createHash('sha256').update('zip').digest('hex') }
    const producer = provenance()
    producer.builds[0].assets[0] = { name: 'Metis-QA-1.9.7.zip', size: 3, sha256: id.installer_sha256 }
    const loadAsar = async () => ({ extractFile: () => Buffer.from('{"name":"asktoto-qa","version":"1.9.7"}') })
    // Windows stat deliberately has no POSIX execute bits. Model only this metadata in synthetic admission tests.
    const modeOf = () => 0o755
    return { cwd, app, installer, executable, id, producer, loadAsar, modeOf }
  }
  it('checks the bundle metadata, ASAR and actual installer hash before any spawn', async () => {
    const data = fixture()
    expect(await verifyHostedApp(data, data.id, data.producer, data)).toBe(data.executable)
    writeFileSync(data.installer, 'bad')
    await expect(verifyHostedApp(data, data.id, data.producer, data)).rejects.toThrow('candidate-rejected')
  })
  it('retains the executable-bit guard and uses real mode by default on every test host', async () => {
    const data = fixture()
    await expect(
      verifyHostedApp(data, data.id, data.producer, { ...data, modeOf: () => 0o644 })
    ).rejects.toThrow('app-rejected')
    const checked = verifyHostedApp(data, data.id, data.producer, { cwd: data.cwd, loadAsar: data.loadAsar })
    if (lstatSync(data.executable).mode & 0o111) await expect(checked).resolves.toBe(data.executable)
    else await expect(checked).rejects.toThrow('app-rejected')
  })
  it.each(['duplicate-app', 'hardlinked-archive', 'wrong-package'])('rejects %s', async (kind) => {
    const data = fixture()
    if (kind === 'duplicate-app') mkdirSync(join(data.cwd, 'candidate-install', 'Other.app'))
    if (kind === 'hardlinked-archive') {
      linkSync(join(data.app, 'Contents', 'Resources', 'app.asar'), join(data.cwd, 'alias'))
    }
    if (kind === 'wrong-package') {
      data.loadAsar = async () => ({ extractFile: () => Buffer.from('{"name":"asktoto","version":"1.9.7"}') })
    }
    await expect(verifyHostedApp(data, data.id, data.producer, data)).rejects.toThrow('app-rejected')
  })
})

describe('fixed candidate network expression (synthetic, not real TLS evidence)', () => {
  const observe = (
    operation: string,
    fetch: (url: string, options: any) => Promise<any>,
    overrides: { pid?: number; electron?: string; ready?: boolean; path?: string } = {}
  ) => {
    const expected = { pid: 42, version: '1.9.7', root: '/probe', userData: '/probe/data' }
    const app = {
      isReady: () => overrides.ready ?? true,
      getVersion: () => '1.9.7',
      getPath: (name: string) => overrides.path ?? (name === 'userData' ? '/probe/data' : '/probe/' + name)
    }
    const process = {
      pid: overrides.pid ?? 42,
      versions: { electron: overrides.electron ?? '43.6.0' },
      mainModule: { require: (name: string) => (name === 'node:path' ? path.posix : { app, net: { fetch } }) }
    }
    return runInNewContext(`(${candidateOperation.toString()})(expected, operation, ports, 50)`, {
      process,
      expected,
      operation,
      ports: { http: 4321, https: 4322 },
      AbortController,
      setTimeout,
      clearTimeout
    }) as Promise<{ code: string }>
  }
  it('rejects wrong process, runtime and profile before network work and reports not-ready separately', async () => {
    const fetch = vi.fn(async () => ({ status: 200 }))
    for (const [override, code] of [
      [{ pid: 43 }, 'owner-mismatch'],
      [{ electron: '42.0.0' }, 'runtime-mismatch'],
      [{ path: '/outside' }, 'profile-mismatch'],
      [{ ready: false }, 'not-ready']
    ] as const) {
      expect((await observe('public-https', fetch, override)).code).toBe(code)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
  it('uses the fixed public endpoint and aborts the parent request after headers without reading a body', async () => {
    let calledUrl = ''
    let options: any
    const result = await observe('public-https', async (url, init) => {
      calledUrl = url
      options = init
      return {
        status: 200,
        get body() {
          throw new Error('body must not be read')
        }
      }
    })
    expect(result.code).toBe('headers-200-abort-requested')
    expect(calledUrl).toBe('https://api.github.com/')
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', bypassCustomProtocolHandlers: true })
    expect(options.signal.aborted).toBe(true)
  })
  it.each([
    ['net::ERR_CERT_AUTHORITY_INVALID', 'authority-rejected'],
    ['ERR_CERT_AUTHORITY_INVALID', 'network-error'],
    ['net::ERR_CERT_DATE_INVALID', 'network-error'],
    ['connection failed', 'network-error']
  ])('recognizes only the pinned authority error: %s', async (message, code) => {
    const answer = await observe('untrusted-certificate', async () => {
      throw new Error(message)
    })
    expect(answer.code).toBe(code)
  })
  it('does not accept generic AbortError as the private deadline reason', async () => {
    const answer = await observe('header-deadline', async () => {
      throw new Error('AbortError')
    })
    expect(answer.code).toBe('network-error')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const promise = observe(
      'header-deadline',
      async (_url, options) =>
        new Promise((_done, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
    )
    await vi.advanceTimersByTimeAsync(50)
    expect((await promise).code).toBe('deadline-rejected')
  })
  it('rejects non-200 and requires the exact redirect message', async () => {
    expect((await observe('non-200-denied', async () => ({ status: 503 }))).code).toBe('status-rejected')
    expect((await observe('public-https', async () => ({ status: 503 }))).code).toBe('status-unexpected')
    const answer = await observe('redirect-denied', async () => {
      throw new Error("Attempted to redirect, but redirect policy was 'error'")
    })
    expect(answer.code).toBe('redirect-rejected')
  })
})

describe('bounded fixed inspector protocol', () => {
  class Socket extends EventEmitter {
    static latest: Socket
    sent: string[] = []
    closeRequested = false
    constructor(_endpoint: string) {
      super()
      Socket.latest = this
    }
    addEventListener(name: string, listener: (...args: any[]) => void) {
      this.on(name, listener)
    }
    send(data: string) {
      this.sent.push(data)
    }
    close() {
      this.closeRequested = true
    }
  }
  it('sends only its fixed operation and settles pending work on close', async () => {
    const transport = createFixedInspector('ws://127.0.0.1:4321/test', Socket)
    const socket = Socket.latest
    socket.emit('open')
    await transport.ready(performance.now() + 1000, () => {})
    const result = transport
      .observe({ pid: 42 }, 'identity', { http: 1, https: 2 }, 1000)
      .catch((error) => error.message)
    expect(JSON.parse(socket.sent[0]).method).toBe('Runtime.evaluate')
    expect(JSON.parse(socket.sent[0]).params.awaitPromise).toBe(true)
    socket.emit('close')
    expect(await result).toBe('inspector-failed')
    expect(await transport.close(performance.now() + 1000)).toBe(true)
  })
  it('cannot convert a late response after deadline into success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const transport = createFixedInspector('ws://127.0.0.1:4321/test', Socket)
    const socket = Socket.latest
    socket.emit('open')
    const result = transport.observe({ pid: 42 }, 'identity', { http: 1, https: 2 }, 50).catch((error) => error.message)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toBe('inspector-failed')
    socket.emit('message', { data: JSON.stringify({ id: 1, result: { result: { value: { code: 'identity-ok' } } } }) })
    await expect(transport.observe({}, 'identity', {}, 50)).rejects.toThrow('inspector-failed')
    const released = transport.close(performance.now() + 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await released).toBe(false)
    expect(socket.closeRequested).toBe(true)
  })
  it('fails closed on wrong request IDs and malformed response values', async () => {
    for (const response of [
      { id: 2, result: { result: { value: { code: 'identity-ok' } } } },
      { id: 1, result: { result: { value: { code: 'identity-ok', raw: 'private' } } } },
      { id: 1, error: { message: 'private' } }
    ]) {
      const transport = createFixedInspector('ws://127.0.0.1:4321/test', Socket)
      const socket = Socket.latest
      socket.emit('open')
      const answer = transport.observe({}, 'identity', {}, 1000).catch((error) => error.message)
      socket.emit('message', { data: JSON.stringify(response) })
      expect(await answer).toBe('inspector-failed')
      socket.emit('close')
      expect(await transport.close(performance.now() + 1000)).toBe(true)
    }
  })
})
