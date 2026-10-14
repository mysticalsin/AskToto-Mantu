import { ipcRenderer } from 'electron'

const pageWindow = globalThis as unknown as {
  postMessage(message: unknown, targetOrigin: string, transfer?: object[]): void
}

ipcRenderer.on('metis-runtime-host-channel', (event) => {
  const port = event.ports[0]
  if (!port) return
  pageWindow.postMessage({ type: 'metis-runtime-host-channel' }, '*', [port])
})

ipcRenderer.on('metis-runtime-host-stop', () => {
  pageWindow.postMessage({ type: 'metis-runtime-host-stop' }, '*')
})
