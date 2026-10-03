const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const ts = require('typescript')
const { app, BrowserWindow, desktopCapturer } = require('electron')

const repoRoot = path.resolve(__dirname, '..', '..', '..')
const helper = process.argv[2]
if (!helper || !existsSync(helper)) {
  console.error('usage: electron-single-window-ocr-row.cjs <metis-mac-helper>')
  process.exit(1)
}

const originalResolve = Module._resolveFilename
Module._resolveFilename = function resolveMetisAliases(request, parent, isMain, options) {
  if (request === '@shared/screen-capture') {
    return path.join(repoRoot, 'src', 'shared', 'screen-capture.ts')
  }
  return originalResolve.call(this, request, parent, isMain, options)
}
require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const source = readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
  module._compile(compiled, filename)
}

const { captureSingleWindowSource } = require(path.join(repoRoot, 'src', 'main', 'screen-capture.ts'))

function blockedExternal() {
  console.log('BLOCKED_EXTERNAL: Screen Recording granted to the test host on the runner image.')
}

function createWindow(title, text, bounds, alwaysOnTop = false) {
  const window = new BrowserWindow({
    title,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true }
  })
  const html = `<!doctype html><html><body style="margin:0;background:white;color:black;font:700 56px system-ui;display:grid;place-items:center;height:100vh">${text}</body></html>`
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return window
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function helperOcrWords(image) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['ocr-words', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ocr-words exited ${code}`))
        return
      }
      resolve(JSON.parse(stdout))
    })
    child.stdin.end(image)
  })
}

async function main() {
  await app.whenReady()
  const suffix = `${Date.now()}-${process.pid}`
  const targetTitle = `Metis OCR Electron Target ${suffix}`
  const overlapTitle = `Metis OCR Electron Overlap ${suffix}`
  const bannerTitle = `Metis OCR Electron Banner ${suffix}`
  const target = createWindow(targetTitle, 'TARGET ONLY', { x: 80, y: 120, width: 760, height: 260 })
  createWindow(overlapTitle, 'OVERLAP NOISE', { x: 120, y: 150, width: 760, height: 260 })
  createWindow(bannerTitle, 'BANNER NOISE', { x: 60, y: 90, width: 840, height: 110 }, true)
  await target.webContents.executeJavaScript('document.fonts.ready')
  await wait(1000)

  let sources
  try {
    sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1280, height: 1280 } })
  } catch {
    blockedExternal()
    return
  }
  if (!sources.length) {
    blockedExternal()
    return
  }
  const source = sources.find((candidate) => candidate.name === targetTitle || candidate.name.includes(targetTitle))
  if (!source) {
    throw new Error(`target window source not found among: ${sources.map((candidate) => candidate.name).join(', ')}`)
  }

  let captured
  try {
    captured = await captureSingleWindowSource(
      { kind: 'window', id: source.id },
      (options) => desktopCapturer.getSources(options)
    )
  } catch {
    blockedExternal()
    return
  }
  const ocr = await helperOcrWords(Buffer.from(captured.image, 'base64'))
  const text = ocr.words.map((word) => word.text.trim().toUpperCase()).join(' ')
  if (!text.includes('TARGET') || !text.includes('ONLY')) {
    throw new Error(`target text missing from OCR result: ${text}`)
  }
  for (const forbidden of ['OVERLAP', 'BANNER', 'NOISE']) {
    if (text.includes(forbidden)) {
      throw new Error(`non-target text leaked into OCR result: ${text}`)
    }
  }
  console.log('ok - captureSingleWindowSource plus ocr-words excludes overlapping and banner windows')
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    app.quit()
    process.exitCode = 1
  })
