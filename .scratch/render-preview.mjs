import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function importTsModule(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2020',
    write: false
  })
  const tmpDir = mkdtempSync(join(tmpdir(), 'metis-preview-'))
  const tmpFile = join(tmpDir, 'mod.mjs')
  writeFileSync(tmpFile, result.outputFiles[0].text)
  const mod = await import(pathToFileURL(tmpFile).href)
  rmSync(tmpDir, { recursive: true, force: true })
  return mod
}

const mapMod = await importTsModule('operator/src/world/map.ts')

const svg = mapMod.renderRealtimeMapSvg({
  points: [
    { country: 'CA', city: 'Longueuil', lat: 45.531, lon: -73.518, count: 1 },
    { country: 'US', city: 'Ashburn', lat: 39.0469, lon: -77.4903, count: 4 },
    { country: 'BR', city: 'São Paulo', lat: -23.5475, lon: -46.6361, count: 7 }
  ],
  theme: 'light'
})

const cornerSvg = mapMod.renderCornerMapSvg({
  countries: [
    { iso: 'CA', count: 4 },
    { iso: 'US', count: 1 },
    { iso: 'BR', count: 7 }
  ]
})

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Metis Operator world map preview</title>
<style>
  body { margin: 0; background: #fff; font-family: sans-serif; }
  .wrap { padding: 16px; }
  h2 { font-size: 14px; color: #333; }
  .rt-map-controls { position: absolute; right: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 4px; }
  .rt-map-zoom { width: 28px; height: 28px; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; }
  .rt-map-fade { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <h2>Realtime map (1152x576)</h2>
  ${svg}
  <h2>Corner map (520x300)</h2>
  ${cornerSvg}
</div>
</body>
</html>
`

writeFileSync('/private/tmp/claude-501/operator-preview/world-map-fix.html', html)
console.log('wrote preview html, bytes', Buffer.byteLength(html))
