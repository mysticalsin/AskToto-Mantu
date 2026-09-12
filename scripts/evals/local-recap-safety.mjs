import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export function writeRunConfig(root, config) {
  const path = join(root, 'eval-config.json')
  writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  return { METIS_LOCAL_RECAP_CONFIG: path }
}

/** Hash actual source bytes, not just HEAD: concurrent or uncommitted edits invalidate a run. */
export function snapshotFiles(root, inputs) {
  const files = []
  const visit = (path) => {
    const rel = relative(root, path)
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Source path escapes the repository')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Source snapshot does not follow symlinks')
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name))
    else if (stat.isFile()) files.push({ path: rel.split(sep).join('/'), bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
    else throw new Error('Unexpected source file type')
  }
  for (const input of [...inputs].sort()) visit(resolve(root, input))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { inputs: [...inputs], files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

export function assertSnapshot(root, snapshot) {
  if (snapshotFiles(root, snapshot.inputs).sha256 !== snapshot.sha256) throw new Error('Frozen source changed during evaluation; discard the mixed-source run')
}

/** @template T @param {() => Promise<T>} work @param {() => void} abort @param {number} ms @returns {Promise<T>} */
export async function withHardDeadline(work, abort, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { abort() } finally { reject(new Error(`Case hard deadline reached after ${ms}ms`)) }
    }, ms)
  })
  try { return await Promise.race([Promise.resolve().then(work), deadline]) }
  finally { clearTimeout(timer) }
}

/** Keep transport protection active during asynchronous teardown, including failure paths. */
export async function withGuardedNetwork(fetchImpl, ports, record, work, cleanup) {
  const previous = globalThis.fetch
  globalThis.fetch = guardedFetch(fetchImpl, ports, record)
  try { return await work() }
  finally {
    try { await cleanup() }
    finally { globalThis.fetch = previous }
  }
}

export function parseArgs(args) {
  const out = { mode: '', trials: 1 }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (['--run', '--check', '--help', '--score'].includes(flag)) {
      if (out.mode) throw new Error('Choose exactly one mode: --check, --run, --score or --help')
      out.mode = flag.slice(2)
      if (flag === '--score') out.score = args[++i]
    } else if (['--binary', '--binary-sha256', '--output', '--baseline', '--temperature', '--trials'].includes(flag)) {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
      out[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    } else throw new Error(`Unknown argument: ${flag}`)
  }
  if (!out.mode) throw new Error('Explicit mode required: --check, --run, --score or --help')
  if (out.mode === 'run' && (!out.binary || !out.binarySha256)) throw new Error('A reviewed --binary and --binary-sha256 are required even for the baseline')
  if (out.binarySha256 && !/^[a-f0-9]{64}$/i.test(out.binarySha256)) throw new Error('Invalid binary SHA256')
  for (const key of ['binary', 'output', 'baseline', 'score']) if (out[key] && !isAbsolute(out[key])) throw new Error(`${key} must be an absolute path`)
  if (out.mode === 'score' && !out.score) throw new Error('--score requires an absolute saved report path')
  if (out.temperature !== undefined) {
    out.temperature = Number(out.temperature)
    if (!Number.isFinite(out.temperature) || out.temperature < 0 || out.temperature > 2) throw new Error('Temperature must be between 0 and 2')
  }
  out.trials = Number(out.trials)
  if (!Number.isInteger(out.trials) || out.trials < 1 || out.trials > 5) throw new Error('Trials must be an integer from 1 to 5')
  return out
}

export function verifyBinary(path, expectedSha256) {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/i.test(expectedSha256 ?? '')) throw new Error('An absolute binary path and reviewed SHA256 are required')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Binary must be a regular file, not a symlink')
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error('Reviewed executable hash mismatch')
  return { path: resolve(path), sha256, bytes: stat.size }
}

export function cleanEnvironment(root, env = process.env) {
  const kept = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]))
  return { ...kept, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, ASKTOTO_USERDATA: root, METIS_DISABLE_APPLE_FM: '1' }
}

/** Each accepted port must have been announced by a child owned by this run. No DNS or redirect. */
export function guardedFetch(fetchImpl, ownedPorts, record = (_request) => {}) {
  return async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !ownedPorts.has(Number(url.port)) || url.username || url.password) throw new Error('Network request denied: only the owned loopback runtime is permitted')
    const body = init.body ?? (input instanceof Request && input.method !== 'GET' ? await input.clone().text() : undefined)
    if (body !== undefined && body !== null) {
      if (typeof body !== 'string' || body.length > 250_000) throw new Error('Unexpected or oversized inference body')
      record({ path: url.pathname, body: JSON.parse(body) })
    }
    return fetchImpl(input, { ...init, redirect: 'error' })
  }
}

/** A killed flag is not an exit: wait for observed reaping, with a bounded failure if it never comes. */
export async function reapOwnedChildren(children) {
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return resolve()
    const exited = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { child.off('exit', exited); reject(new Error(`Owned runtime did not exit: ${child.pid}`)) }, 3_000)
    child.once('exit', exited)
    child.kill('SIGKILL')
  })))
}
