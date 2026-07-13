import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // electron-vite compiles the main-process bundle to V8 bytecode (.jsc): the shipped app carries
    // no readable main-process JS at all — prompts, brain/ingest logic, and LLM orchestration can't be
    // read out of the asar. Renderer/preload stay minified-only (a sandboxed preload and a Chromium
    // renderer can't load bytecode). This is a hardening bar, not absolute protection.
    build: {
      bytecode: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
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
