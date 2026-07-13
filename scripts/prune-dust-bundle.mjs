#!/usr/bin/env node
/**
 * @dust-tt/client 1.2.6 bundles an MCP server SDK even though its compiled DustAPI client is
 * self-contained. npm cannot override bundled dependencies, so remove that unused duplicate after
 * every install. The root MCP SDK remains installed for Métis's own MCP integrations.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dustRoot = join(root, 'node_modules', '@dust-tt', 'client')
const distRoot = join(dustRoot, 'dist')
const bundledRoot = join(dustRoot, 'node_modules')
const unused = ['@modelcontextprotocol/sdk', 'express-rate-limit', 'ip-address']

if (!existsSync(distRoot)) throw new Error(`Dust client build is missing: ${distRoot}`)

for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue
  const source = readFileSync(join(distRoot, entry.name), 'utf8')
  for (const dependency of unused) {
    const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const externalImport = new RegExp(
      `(?:require\\s*\\(\\s*|from\\s+|import\\s*\\(\\s*)['\"]${escaped}(?:[/\"'])`
    )
    if (externalImport.test(source)) {
      throw new Error(`Dust client now imports ${dependency}; refusing to prune its bundled copy`)
    }
  }
}

for (const dependency of unused) {
  rmSync(join(bundledRoot, ...dependency.split('/')), { recursive: true, force: true })
}

console.log('[prune:dust-bundle] OK — removed unused bundled MCP server dependencies')
