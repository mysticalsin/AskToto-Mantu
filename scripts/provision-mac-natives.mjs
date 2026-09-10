#!/usr/bin/env node
/**
 * Install both macOS architectures of every prebuilt native addon in one npm invocation.
 * npm's forced no-save re-resolution prunes packages not present in that invocation, so Sharp,
 * libvips, and Sherpa must remain together. The tested core derives exact Sharp pairs from the
 * installed core plus lock metadata and verifies exact loader/native output before succeeding.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionMacNatives } from './provision-mac-natives-core.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  try {
    provisionMacNatives({ root: REPO_ROOT })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

export { provisionMacNatives }
