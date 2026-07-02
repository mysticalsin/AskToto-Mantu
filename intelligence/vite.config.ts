import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative base: the packaged build is loaded over file:// inside AskToto's Intelligence window,
  // where absolute /assets/ paths would resolve to the filesystem root and 404.
  base: './',
  plugins: [react(), tailwindcss()],
})
