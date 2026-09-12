#!/usr/bin/env node
/**
 * No-network release gate for the Métis Local model payload.
 *
 * Verify the build inputs against the same exact model/projector/license inventory used after
 * packaging. Only the tracked blank root .gitkeep is allowed in the build tree, never the installer.
 */
import './check-offline-package.mjs'
import { dirname } from 'node:path'
import { LOCAL_MODEL_LICENSE, LOCAL_MODEL_PAYLOAD } from './local-model-assets.mjs'
import { verifyLocalModelPayload } from './lib/local-model-inventory.mjs'

const assets = await verifyLocalModelPayload(dirname(LOCAL_MODEL_LICENSE.path), LOCAL_MODEL_PAYLOAD, {
  allowBuildGitkeep: true
})
for (const asset of assets) {
  console.log(`[check:local-model] OK ${asset.path} (${asset.bytes} bytes, ${asset.sha256})`)
}

console.log('[check:local-model] OK exactly one bundled model: qwen3.5-0.8b')
