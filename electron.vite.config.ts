import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin, bytecodePlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // bytecodePlugin compiles the main-process bundle to V8 bytecode (.jsc): the shipped app carries
    // no readable main-process JS at all — prompts, brain/ingest logic, and LLM orchestration can't be
    // read out of the asar. Renderer/preload stay minified-only (a sandboxed preload and a Chromium
    // renderer can't load bytecode). This is a hardening bar, not absolute protection.
    plugins: [externalizeDepsPlugin(), bytecodePlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    // Bundle zod into the preload (a sandboxed preload cannot require() externalized deps).
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      minify: 'esbuild', // preload parses before first paint — same unminified-default fix as renderer
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // Minimal preload for the Mantu Intelligence dashboard window (see src/main/intelligence.ts).
          intelligence: resolve(__dirname, 'src/preload/intelligence.ts')
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
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    // transformers.js ships wasm + workers; don't pre-bundle it
    optimizeDeps: { exclude: ['@huggingface/transformers'] },
    worker: { format: 'es' }
  }
})
