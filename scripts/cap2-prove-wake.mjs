import http from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import CDP from 'chrome-remote-interface'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
// fix: proof is under agent-tools; repo is metis-dock-design
const REPO = process.env.ASKTOTO_REPO || '/Users/tony/dev/metis-dock-design'
const PROFILE = process.env.ASKTOTO_USERDATA
const electronBin = path.join(REPO, 'node_modules', 'electron', 'cli.js')

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

const child = spawn(process.execPath, [electronBin, '.', '--remote-debugging-port=9339', `--user-data-dir=${PROFILE}`], {
  cwd: REPO,
  env: { ...process.env, ASKTOTO_CAP2_PROVE: '1', ELECTRON_RUN_AS_NODE: '' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let err = ''
child.stderr.on('data', (b) => {
  err += b.toString()
  process.stderr.write(b)
})

let page = null
for (let i = 0; i < 50; i++) {
  await sleep(400)
  try {
    const list = await get('http://127.0.0.1:9339/json/list')
    page = list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
    if (page) break
  } catch {
    /* retry */
  }
}
if (!page) {
  child.kill()
  console.error('NO_PAGE')
  process.exit(2)
}

await sleep(3000)
const client = await CDP({ target: page.webSocketDebuggerUrl })
const { Runtime } = client
await Runtime.enable()
const { result } = await Runtime.evaluate({
  expression:
    "window.toto.cap2ProveWake ? window.toto.cap2ProveWake() : Promise.resolve({ error: 'no cap2ProveWake' })",
  awaitPromise: true,
  returnByValue: true
})
await client.close()

const value = result?.value
console.log('PROVE_RESULT', JSON.stringify(value, null, 2))
const heardReveal = /\[cap2\] command pill host/.test(err)
const heardProve = /\[cap2\] proveWake/.test(err)
const heardAsrPath = /coerceFloat32Pcm|you-asr|cap2/.test(err)
console.log('LOG_reveal', heardReveal)
console.log('LOG_proveWake', heardProve)

child.kill()
const ok = value?.pillVisible === true && heardReveal && heardProve
process.exit(ok ? 0 : 1)
