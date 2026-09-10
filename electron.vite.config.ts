import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// MQA-207. A V8 code cache is per-ARCHITECTURE: V8 only accepts cached data produced by a matching
// V8 build. electron-vite emits exactly ONE out/main/index.jsc, compiled by spawning the build host's
// own Electron — so on an Apple Silicon host that blob is arm64 bytecode. electron-builder's
// --universal package merges the two sub-builds into a SINGLE app.asar, so the x86_64 slice is handed
// bytecode it cannot load and dies on launch, before any of our code runs, with:
//
//   Error: Invalid or incompatible cached data (cachedDataRejected)
//     at Module._extensions..jsc (out/main/bytecode-loader.cjs:50:11)
//
// Reported from a real launch of the 1.6.0 universal DMG, and reproducible with the exact command
// scripts/check-packaged-launch.mjs prints for a maintainer:
//   arch -x86_64 release/mac-universal/Metis.app/Contents/MacOS/Metis
// No single blob satisfies both slices, so a universal package cannot use bytecode at all.
//
// Bytecode therefore stays ON wherever the package is single-architecture (Windows, and the
// arm64-only installers:mac / release:mas chains) and is turned OFF only for the mac UNIVERSAL
// chains, which set ASKTOTO_MAC_UNIVERSAL=1 on their `npm run build` step (package.json: dist,
// dist:local, release:build:mac). The flag is used rather than process.platform because the SAME
// macOS host builds both kinds, so the platform cannot tell them apart.
//
// The trade-off is deliberate: the mac universal artifact ships a readable main-process bundle
// instead of bytecode. An app that starts beats an app that is obfuscated and does not.
const MAC_UNIVERSAL = process.env.ASKTOTO_MAC_UNIVERSAL === '1'

export default defineConfig({
  main: {
    // electron-vite compiles the main-process bundle to V8 bytecode (.jsc): the shipped app carries
    // no readable main-process JS at all — prompts, brain/ingest logic, and LLM orchestration can't be
    // read out of the asar. Renderer/preload stay minified-only (a sandboxed preload and a Chromium
    // renderer can't load bytecode). This is a hardening bar, not absolute protection.
    build: {
      // bytecode: true everywhere EXCEPT the mac universal package — see the MQA-207 note above.
      bytecode: !MAC_UNIVERSAL,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Parakeet's sherpa/ONNX runtime is isolated from both the main event loop and Whisper's
          // transformers/ONNX runtime. Keeping it as a distinct entry is required on Windows too,
          // where the two native runtimes ship colliding DLL names.
          'parakeet-asr-host': resolve(__dirname, 'src/main/parakeet-asr-host.ts'),
          // MQA-234: the whisper utilityProcess child. Its own entry so it never shares a chunk with
          // main — the whole point is that transformers/onnxruntime-node load ONLY in the child.
          'whisper-asr-host': resolve(__dirname, 'src/main/whisper-asr-host.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    // Bundle zod into the preload (a sandboxed preload cannot require() externalized deps).
    build: {
      externalizeDeps: { exclude: ['zod'] },
      minify: 'esbuild', // preload parses before first paint — same unminified-default fix as renderer
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Minimal preload for the Mantu Intelligence dashboard window (see src/main/intelligence.ts).
          intelligence: resolve(__dirname, 'src/preload/intelligence.ts'),
          // Isolated Chromium audio decoder used by main-owned import jobs. It exposes no app APIs.
          'import-decoder': resolve(__dirname, 'src/preload/import-decoder.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // electron-vite defaults to minify:false — that shipped every bundle unminified (≈2x parse
      // bytes on the entry chunk and on every lazy view's first click). Main stays readable for
      // crash-log stack traces; the renderer is where the cold-start parse cost lives.
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          decoder: resolve(__dirname, 'src/renderer/decoder.html')
        }
      }
    },
    // transformers.js ships wasm + workers; don't pre-bundle it
    optimizeDeps: { exclude: ['@huggingface/transformers'] },
    worker: { format: 'es' }
  }
})
