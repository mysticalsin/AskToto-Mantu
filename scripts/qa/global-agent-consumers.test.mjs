import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer as createHttpServer, request as requestHttp } from 'node:http'
import { connect as connectNet } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname, relative, sep } from 'node:path'
import { createServer as createTlsServer } from 'node:https'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'

const repositoryRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
const repositoryRequire = createRequire(join(repositoryRoot, 'package.json'))
const repositoryManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
const repositoryLock = JSON.parse(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'))
const derivativeUrl =
  'https://raw.githubusercontent.com/mysticalsin/AskToto-Mantu/cffe92f93fd440243766924c9e08f67df6652861/vendor/global-agent/4.1.3-metis-ip-host.tgz'
const derivativeIntegrity =
  'sha512-p+KdYIWfdrsO/BPB3nN/b5Rr3/8c+3dP2bdF0O/bVk/+ReJIZXLxLFAxt75fAinv1LAdsWxZKDXDW8nzeJM+rQ=='
const derivativeArchivePath = join(repositoryRoot, 'vendor', 'global-agent', '4.1.3-metis-ip-host.tgz')
const derivativeModuleSha256 = '2548c955fc8fc40615a6722af6627b6d563a1dd586791d4f486feb9b4bfafaa0'
const onnxEntry = repositoryRequire.resolve('onnxruntime-node')
const onnxRequire = createRequire(onnxEntry)
const onnxGlobalAgentEntry = onnxRequire.resolve('global-agent')
const onnxPackageRoot = findPackageRoot(onnxEntry, 'onnxruntime-node')
const onnxInstallEntry = join(onnxPackageRoot, 'script', 'install.js')
const appBuilderEntry = repositoryRequire.resolve('app-builder-lib')
const appBuilderRequire = createRequire(appBuilderEntry)
const electronGetEntry = appBuilderRequire.resolve('@electron/get')
const electronGetRequire = createRequire(electronGetEntry)
const electronGetGlobalAgentEntry = electronGetRequire.resolve('global-agent')
const onnxVersion = packageVersion(onnxEntry, 'onnxruntime-node')
const electronGetVersion = packageVersion(electronGetEntry, '@electron/get')

function findPackageRoot(entry, expectedName) {
  let directory = dirname(entry)
  while (true) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const packageJson = JSON.parse(readFileSync(manifest, 'utf8'))
      if (packageJson.name === expectedName) return directory
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Could not locate package root: ${expectedName}`)
    directory = parent
  }
}

function packageVersion(entry, expectedName) {
  return JSON.parse(readFileSync(join(findPackageRoot(entry, expectedName), 'package.json'), 'utf8')).version
}

const consumers = [
  {
    id: 'onnx',
    label: 'onnxruntime-node install parent',
    overrideParent: 'onnxruntime-node@1.21.0',
    parentEntry: onnxEntry,
    globalAgentEntry: onnxGlobalAgentEntry
  },
  {
    id: 'electron-get',
    label: 'app-builder-lib @electron/get parent',
    overrideParent: '@electron/get@3.1.0',
    electronGetEntry,
    globalAgentEntry: electronGetGlobalAgentEntry
  }
]

const childProgram = String.raw`
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

function requestText(client, url) {
  return new Promise((resolve, reject) => {
    const request = client.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096) response.destroy(new Error('response exceeded fixture bound'))
      })
      response.on('end', () => resolve({ status: response.statusCode, body }))
      response.on('error', reject)
    })
    request.setTimeout(5000, () => request.destroy(Object.assign(new Error('fixture request timeout'), { code: 'ETIMEDOUT' })))
    request.on('error', reject)
  })
}

function assertExpectedAgent(agent) {
  const assert = require('node:assert/strict')
  if (!agent) throw new Error('parent did not initialize global-agent')
  assert.equal(agent.HTTP_PROXY, process.env.METIS_GA_EXPECTED_PROXY)
  assert.equal(agent.HTTPS_PROXY, process.env.METIS_GA_EXPECTED_PROXY)
  assert.equal(agent.NO_PROXY, process.env.METIS_GA_EXPECTED_NO_PROXY)
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled')
  return agent
}

let requestPhase = 'bootstrap'

async function main() {
  const mode = process.env.METIS_GA_MODE
  if (mode === 'onnx' || mode === 'onnx-install') {
    const onnxRequire = createRequire(process.env.METIS_GA_ONNX_ENTRY)
    if (mode === 'onnx-install') {
      process.env.ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip'
      const net = require('node:net')
      const originalConnect = net.Socket.prototype.connect
      net.Socket.prototype.connect = function (...args) {
        const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }
        const host = options.host || options.hostname || 'localhost'
        if (!['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host)) {
          throw new Error('external network access forbidden in ONNX install smoke')
        }
        return originalConnect.apply(this, args)
      }
      const childProcess = require('node:child_process')
      for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
        childProcess[name] = () => { throw new Error('child process execution forbidden in ONNX install smoke') }
      }
      process.dlopen = () => { throw new Error('native module loading forbidden in ONNX install smoke') }
      require('node:module')._extensions['.node'] = () => { throw new Error('native module load forbidden in ONNX install smoke') }
      process.once('exit', (code) => {
        assert.equal(code, 0, 'ONNX install script must exit successfully')
        assertExpectedAgent(global.GLOBAL_AGENT)
        require('node:fs').writeSync(1, 'METIS_GA_RESULT=' + JSON.stringify({ initialized: true }) + '\n')
      })
      require(process.env.METIS_GA_ONNX_INSTALL)
      throw new Error('ONNX install script unexpectedly returned instead of exiting after bootstrap')
    } else {
      onnxRequire('global-agent').bootstrap()
    }
  } else if (mode === 'electron-get') {
    delete process.env.ELECTRON_GET_USE_PROXY
    require(process.env.METIS_GA_ELECTRON_GET_ENTRY).initializeProxy()
  } else {
    throw new Error('unknown compatibility parent')
  }

  assertExpectedAgent(global.GLOBAL_AGENT)
  const http = require('node:http')
  const https = require('node:https')

  if (process.env.METIS_GA_ACTION === 'bootstrap-only') {
    process.stdout.write('METIS_GA_RESULT=' + JSON.stringify({ initialized: true }) + '\n')
    return
  }

  const httpsUrl = process.env.METIS_GA_HTTPS_URL
  if (process.env.METIS_GA_ACTION === 'untrusted-tls' || process.env.METIS_GA_ACTION === 'wrong-name-tls') {
    requestPhase = 'https'
    let code = null
    try {
      await requestText(https, httpsUrl)
    } catch (error) {
      code = error.code || null
    }
    if (!code) throw new Error('untrusted TLS origin unexpectedly succeeded')
    process.stdout.write('METIS_GA_RESULT=' + JSON.stringify({ initialized: true, tlsRejected: true, tlsErrorCode: code }) + '\n')
    return
  }

  requestPhase = 'http'
  const httpResult = await requestText(http, process.env.METIS_GA_HTTP_URL)
  requestPhase = 'https'
  const httpsResult = await requestText(https, httpsUrl)
  process.stdout.write('METIS_GA_RESULT=' + JSON.stringify({ initialized: true, http: httpResult, https: httpsResult }) + '\n')
}

main().catch((error) => {
  const safeCodes = new Set([
    'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPROTO'
  ])
  const code = safeCodes.has(error?.code) ? error.code : 'OTHER'
  process.stderr.write('METIS_GA_CHILD_FAILURE phase=' + requestPhase + ' code=' + code + '\n')
  process.exitCode = 1
})
`

let temporaryRoot
let httpOrigin
let tlsOrigin
let wrongNameTlsOrigin
let proxy
let httpPort
let tlsPort
let wrongNameTlsPort
let proxyPort
const sockets = new Set()
const tunnelSockets = new Set()
const traffic = { proxyHttp: [], proxyConnect: [], httpOrigin: [], tlsOrigin: [] }

function trackConnections(server) {
  server.requestTimeout = 8000
  server.headersTimeout = 8000
  server.keepAliveTimeout = 100
  server.maxHeadersCount = 32
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
}

function listenLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve()
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(() => resolve()))
}

function createCertificate(directory, name, subjectAltName) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certificatePath = join(directory, `${name}-cert.pem`)
  const configPath = join(directory, `${name}-openssl.cnf`)
  writeFileSync(
    configPath,
    `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${name}\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=${subjectAltName}\n`
  )
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
      '-days',
      '1',
      '-config',
      configPath
    ],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true }
  )
  assert.equal(result.error, undefined, 'OpenSSL must be installed to create the ephemeral loopback TLS certificate')
  assert.equal(result.status, 0, 'OpenSSL must create the ephemeral loopback TLS certificate')
  return { key: readFileSync(keyPath), cert: readFileSync(certificatePath), certificatePath }
}

test.before(async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), 'metis-global-agent-compat-'))
  const certificate = createCertificate(temporaryRoot, 'loopback', 'IP:127.0.0.1')
  const wrongNameCertificate = createCertificate(temporaryRoot, 'wrong-name', 'IP:192.0.2.99')

  httpOrigin = createHttpServer((request, response) => {
    traffic.httpOrigin.push(request.url)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`http:${request.url}`)
  })
  tlsOrigin = createTlsServer(certificate, (request, response) => {
    traffic.tlsOrigin.push(request.url)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`https:${request.url}`)
  })
  wrongNameTlsOrigin = createTlsServer(wrongNameCertificate, (request, response) => {
    traffic.tlsOrigin.push(request.url)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(`https:${request.url}`)
  })

  proxy = createHttpServer((request, response) => {
    traffic.proxyHttp.push(request.url)
    let target
    try {
      target = new URL(request.url)
    } catch {
      response.writeHead(400)
      response.end()
      return
    }
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || Number(target.port) !== httpPort) {
      response.writeHead(502)
      response.end()
      return
    }
    const outbound = requestHttp(
      {
        hostname: '127.0.0.1',
        port: httpPort,
        method: request.method,
        path: `${target.pathname}${target.search}`
      },
      (originResponse) => {
        response.writeHead(originResponse.statusCode || 502, originResponse.headers)
        originResponse.pipe(response)
      }
    )
    outbound.on('error', () => {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    })
    request.pipe(outbound)
  })

  proxy.on('connect', (request, clientSocket, head) => {
    traffic.proxyConnect.push(request.url)
    const target = new URL(`http://${request.url}`)
    if (target.hostname !== '127.0.0.1' || ![tlsPort, wrongNameTlsPort].includes(Number(target.port))) {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const upstream = connectNet(tlsPort, '127.0.0.1')
    tunnelSockets.add(clientSocket)
    tunnelSockets.add(upstream)
    clientSocket.on('close', () => tunnelSockets.delete(clientSocket))
    upstream.on('close', () => tunnelSockets.delete(upstream))
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on('error', () => clientSocket.destroy())
  })

  for (const server of [httpOrigin, tlsOrigin, wrongNameTlsOrigin, proxy]) trackConnections(server)
  httpPort = await listenLoopback(httpOrigin)
  tlsPort = await listenLoopback(tlsOrigin)
  wrongNameTlsPort = await listenLoopback(wrongNameTlsOrigin)
  proxyPort = await listenLoopback(proxy)
})

test.after(async () => {
  for (const socket of tunnelSockets) socket.destroy()
  for (const socket of sockets) socket.destroy()
  await Promise.all([
    closeServer(proxy),
    closeServer(wrongNameTlsOrigin),
    closeServer(tlsOrigin),
    closeServer(httpOrigin)
  ])
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
})

function childEnvironment(consumer, { noProxy, trustedTls = false, action = 'requests', mode = consumer.id }) {
  const environment = { ...process.env }
  for (const name of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
    'GLOBAL_AGENT',
    'GLOBAL_AGENT_HTTP_PROXY',
    'GLOBAL_AGENT_HTTPS_PROXY',
    'GLOBAL_AGENT_NO_PROXY',
    'GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE',
    'GLOBAL_AGENT_FORCE_GLOBAL_AGENT',
    'GLOBAL_AGENT_SOCKET_CONNECTION_TIMEOUT',
    'FORCE_GLOBAL_AGENT',
    'force_global_agent',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_OPTIONS',
    'ELECTRON_GET_USE_PROXY',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_http_proxy',
    'npm_config_no_proxy',
    'NPM_CONFIG_PROXY',
    'NPM_CONFIG_HTTPS_PROXY',
    'NPM_CONFIG_HTTP_PROXY',
    'NPM_CONFIG_NO_PROXY'
  ])
    delete environment[name]

  const proxyUrl = `http://127.0.0.1:${proxyPort}`
  environment.METIS_GA_MODE = mode
  environment.METIS_GA_ACTION = action
  environment.METIS_GA_EXPECTED_PROXY = proxyUrl
  environment.METIS_GA_EXPECTED_NO_PROXY = noProxy
  environment.METIS_GA_HTTP_URL = `http://127.0.0.1:${httpPort}/through-http-proxy`
  environment.METIS_GA_HTTPS_URL = `https://127.0.0.1:${tlsPort}/through-https-proxy`
  environment.METIS_GA_ONNX_ENTRY = onnxEntry
  environment.METIS_GA_ONNX_INSTALL = onnxInstallEntry
  environment.METIS_GA_ELECTRON_GET_ENTRY = electronGetEntry
  environment.GLOBAL_AGENT_SOCKET_CONNECTION_TIMEOUT = '5000'
  if (consumer.id === 'onnx') {
    environment.GLOBAL_AGENT_HTTP_PROXY = proxyUrl
    environment.GLOBAL_AGENT_HTTPS_PROXY = proxyUrl
    environment.GLOBAL_AGENT_NO_PROXY = noProxy
    delete environment.HTTP_PROXY
    delete environment.HTTPS_PROXY
    delete environment.NO_PROXY
  } else {
    environment.HTTP_PROXY = proxyUrl
    environment.HTTPS_PROXY = proxyUrl
    environment.NO_PROXY = noProxy
  }
  if (trustedTls) environment.NODE_EXTRA_CA_CERTS = join(temporaryRoot, 'loopback-cert.pem')
  if (action === 'wrong-name-tls') {
    environment.METIS_GA_HTTPS_URL = `https://127.0.0.1:${wrongNameTlsPort}/wrong-name`
    environment.NODE_EXTRA_CA_CERTS = join(temporaryRoot, 'wrong-name-cert.pem')
  }
  if (mode === 'onnx-install') environment.ONNXRUNTIME_NODE_INSTALL_CUDA = 'skip'
  return environment
}

function runIsolated(consumer, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childProgram], {
      env: childEnvironment(consumer, options),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 12_000)
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr]
    ]) {
      stream.on('data', (chunk) => {
        outputBytes += chunk.length
        if (outputBytes > 64 * 1024) {
          child.kill()
          return
        }
        chunks.push(chunk)
      })
    }
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error('isolated compatibility child timed out'))
      if (outputBytes > 64 * 1024) return reject(new Error('isolated compatibility child output exceeded its bound'))
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      resolve({ code, signal, stdout: out, stderr: err })
    })
  })
}

async function runRequests(consumer, options = {}) {
  const result = await runIsolated(consumer, { noProxy: '192.0.2.99', trustedTls: true, ...options })
  const failure = result.stderr.match(
    /METIS_GA_CHILD_FAILURE phase=(bootstrap|http|https) code=(ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPROTO|OTHER)/
  )
  assert.equal(
    result.code,
    0,
    `isolated parent must complete local HTTP and trusted HTTPS requests; phase=${failure?.[1] ?? 'UNKNOWN'} code=${failure?.[2] ?? 'UNKNOWN'}`
  )
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('METIS_GA_RESULT='))
  assert.ok(line, 'isolated parent must return bounded request results')
  return JSON.parse(line.slice('METIS_GA_RESULT='.length))
}

test('actual ONNX and @electron/get parent resolution uses the exact scoped global-agent pin', () => {
  assert.equal(onnxVersion, '1.21.0', 'test must exercise the installed onnxruntime-node parent')
  assert.equal(electronGetVersion, '3.1.0', 'test must exercise the installed app-builder-lib @electron/get parent')
  const archive = readFileSync(derivativeArchivePath)
  assert.equal(archive.byteLength, 17_984, 'vendored derivative archive must have its approved byte length')
  assert.equal(
    createHash('sha256').update(archive).digest('hex'),
    'd8980b684aa265bb4398b472fb70d41e0475c5d430189eb917f3ce646edf8492'
  )
  assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, derivativeIntegrity)
  for (const consumer of consumers) {
    assert.equal(packageVersion(consumer.globalAgentEntry, 'global-agent'), '4.1.3', consumer.label)
    const globalAgentRoot = findPackageRoot(consumer.globalAgentEntry, 'global-agent')
    const lockPath = relative(repositoryRoot, globalAgentRoot).split(sep).join('/')
    const lockEntry = repositoryLock.packages[lockPath]
    assert.ok(lockEntry, `${consumer.label} package root must map to its exact lock record: ${lockPath}`)
    assert.equal(lockEntry.version, '4.1.3', `${consumer.label} lock version`)
    assert.equal(lockEntry.resolved, derivativeUrl, `${consumer.label} must resolve from the immutable derivative URL`)
    assert.equal(lockEntry.integrity, derivativeIntegrity, `${consumer.label} must match the derivative archive SRI`)
    assert.equal(repositoryManifest.overrides[consumer.overrideParent]['global-agent'], derivativeUrl)
    const httpsProxyAgent = readFileSync(join(globalAgentRoot, 'dist', 'classes', 'HttpsProxyAgent.js'))
    assert.equal(
      createHash('sha256').update(httpsProxyAgent).digest('hex'),
      derivativeModuleSha256,
      `${consumer.label} installed patched module bytes`
    )
  }
})

for (const consumer of consumers) {
  test(
    `${consumer.label} routes HTTP and trusted HTTPS through the configured loopback proxy`,
    { timeout: 30_000 },
    async () => {
      const httpBefore = traffic.proxyHttp.length
      const connectBefore = traffic.proxyConnect.length
      const result = await runRequests(consumer)
      assert.equal(result.initialized, true)
      assert.deepEqual(result.http, { status: 200, body: 'http:/through-http-proxy' })
      assert.deepEqual(result.https, { status: 200, body: 'https:/through-https-proxy' })
      assert.equal(traffic.proxyHttp.length, httpBefore + 1)
      assert.equal(traffic.proxyConnect.length, connectBefore + 1)
      assert.ok(traffic.proxyHttp.at(-1).includes(`/through-http-proxy`))
      assert.deepEqual(traffic.proxyConnect.at(-1), `127.0.0.1:${tlsPort}`)
    }
  )

  test(`${consumer.label} honors a matching NO_PROXY host for HTTP and HTTPS`, { timeout: 30_000 }, async () => {
    const httpBefore = traffic.proxyHttp.length
    const connectBefore = traffic.proxyConnect.length
    const originHttpBefore = traffic.httpOrigin.length
    const originTlsBefore = traffic.tlsOrigin.length
    const result = await runRequests(consumer, { noProxy: '127.0.0.1' })
    assert.equal(result.initialized, true)
    assert.deepEqual(result.http, { status: 200, body: 'http:/through-http-proxy' })
    assert.deepEqual(result.https, { status: 200, body: 'https:/through-https-proxy' })
    assert.equal(traffic.proxyHttp.length, httpBefore)
    assert.equal(traffic.proxyConnect.length, connectBefore)
    assert.equal(traffic.httpOrigin.length, originHttpBefore + 1)
    assert.equal(traffic.tlsOrigin.length, originTlsBefore + 1)
  })

  test(`${consumer.label} rejects an untrusted TLS origin while proxying`, { timeout: 30_000 }, async () => {
    const connectBefore = traffic.proxyConnect.length
    const result = await runIsolated(consumer, { noProxy: '192.0.2.99', action: 'untrusted-tls' })
    assert.equal(result.code, 0, 'isolated parent must report certificate rejection')
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('METIS_GA_RESULT='))
    assert.ok(line, 'isolated parent must return its TLS rejection result')
    const report = JSON.parse(line.slice('METIS_GA_RESULT='.length))
    assert.equal(report.tlsRejected, true)
    assert.match(report.tlsErrorCode, /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/)
    assert.equal(traffic.proxyConnect.length, connectBefore + 1)
    assert.deepEqual(traffic.proxyConnect.at(-1), `127.0.0.1:${tlsPort}`)
  })

  test(
    `${consumer.label} rejects a trusted TLS origin with the wrong IP SAN while proxying`,
    { timeout: 30_000 },
    async () => {
      const connectBefore = traffic.proxyConnect.length
      const result = await runIsolated(consumer, {
        noProxy: '192.0.2.88',
        action: 'wrong-name-tls'
      })
      assert.equal(result.code, 0, 'isolated parent must report the trusted certificate name rejection')
      const line = result.stdout.split('\n').find((entry) => entry.startsWith('METIS_GA_RESULT='))
      assert.ok(line, 'isolated parent must return its TLS rejection result')
      const report = JSON.parse(line.slice('METIS_GA_RESULT='.length))
      assert.equal(report.tlsRejected, true)
      assert.equal(report.tlsErrorCode, 'ERR_TLS_CERT_ALTNAME_INVALID')
      assert.equal(traffic.proxyConnect.length, connectBefore + 1)
      assert.deepEqual(traffic.proxyConnect.at(-1), `127.0.0.1:${wrongNameTlsPort}`)
    }
  )
}

test(
  'ONNX install.js with ONNXRUNTIME_NODE_INSTALL_CUDA=skip bootstraps without network or native module loading',
  { timeout: 30_000 },
  async () => {
    const httpBefore = traffic.proxyHttp.length
    const connectBefore = traffic.proxyConnect.length
    const httpOriginBefore = traffic.httpOrigin.length
    const tlsOriginBefore = traffic.tlsOrigin.length
    const onnxConsumer = consumers[0]
    const result = await runIsolated(onnxConsumer, {
      noProxy: '192.0.2.99',
      action: 'bootstrap-only',
      mode: 'onnx-install'
    })
    assert.equal(result.code, 0, 'ONNXRUNTIME_NODE_INSTALL_CUDA=skip install smoke must return successfully')
    assert.match(result.stdout, /METIS_GA_RESULT=\{"initialized":true\}/)
    assert.equal(traffic.proxyHttp.length, httpBefore)
    assert.equal(traffic.proxyConnect.length, connectBefore)
    assert.equal(traffic.httpOrigin.length, httpOriginBefore)
    assert.equal(traffic.tlsOrigin.length, tlsOriginBefore)
  }
)
