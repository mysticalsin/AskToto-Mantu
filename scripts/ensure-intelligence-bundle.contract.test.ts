import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const ensure = readFileSync(join(__dirname, 'ensure-intelligence-bundle.mjs'), 'utf8')
const intel = readFileSync(join(root, 'src/main/intelligence.ts'), 'utf8')
const button = readFileSync(
  join(root, 'intelligence/src/components/IntelligenceUpdateButton.tsx'),
  'utf8'
)
const tsconfig = readFileSync(join(root, 'intelligence/tsconfig.app.json'), 'utf8')
const viteEnv = readFileSync(join(root, 'intelligence/src/vite-env.d.ts'), 'utf8')

describe('Intelligence bundle is part of a normal build', () => {
  // MQA-290 — Totos-Mac tsc -b: Cannot find namespace JSX
  it('npm run build and npm run dev both ensure the dashboard bundle', () => {
    expect(pkg.scripts.prebuild).toMatch(/ensure-intelligence-bundle/)
    expect(pkg.scripts.dev).toMatch(/ensure-intelligence-bundle/)
    expect(pkg.scripts['build:intelligence']).toMatch(/intelligence/)
    expect(ensure).toMatch(/build:intelligence/)
    expect(ensure).toMatch(/intelligence\/dist\/index\.html/)
    expect(ensure).not.toMatch(/: boolean/)
    expect(intel).toMatch(/bundleIndexHtml/)
    expect(intel).toMatch(/Intelligence dashboard bundle not found/)
    expect(button).toMatch(/ReactElement/)
    expect(button).not.toMatch(/JSX\.Element/)
    expect(tsconfig).toMatch(/"react"/)
    expect(tsconfig).toMatch(/"react-dom"/)
    expect(tsconfig).toMatch(/"jsx": "react-jsx"/)
    expect(viteEnv).toMatch(/<reference types="react" \/>/)
  })
})
