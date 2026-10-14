/** Optional LLM provisioning policy. Transcription assets have a separate mandatory setup path. */
export async function provisionLocalModel(
  local: { enabled: boolean; modelId: string },
  allowedProviders: readonly string[] | null,
  ensure: (modelId: string) => Promise<boolean>,
  trigger: 'automatic' | 'explicit' = 'automatic'
): Promise<boolean> {
  if (allowedProviders && !allowedProviders.includes('local')) return false
  if (trigger === 'automatic' && !local.enabled) return false
  // The downloader owns model-id, RAM, disk, integrity and single-flight checks. Never replace the
  // selected model with a larger one merely because this machine has enough memory for it.
  return ensure(local.modelId)
}

/** Explicit user action admission; each read callback is a fresh policy/profile authority boundary. */
export async function provisionExplicitLocalModel(options: {
  runtimeAvailable: () => Promise<boolean>
  readSettings: () => { settings: { localLlm: { enabled: boolean; modelId: string } }; readable: boolean }
  allowedProviders: () => readonly string[] | null
  ensure: (modelId: string) => Promise<boolean>
  onReady: () => void
}): Promise<boolean> {
  if (!(await options.runtimeAvailable())) return false
  const admission = options.readSettings()
  if (!admission.readable) return false
  const admittedModel = admission.settings.localLlm
  const ready = await provisionLocalModel(admittedModel, options.allowedProviders(), options.ensure, 'explicit')
  if (!ready) return false
  const current = options.readSettings()
  if (!current.readable || current.settings.localLlm.modelId !== admittedModel.modelId) return false
  options.onReady()
  return true
}

export function registerExplicitLocalModelEnsure(options: {
  ipcMain: Electron.IpcMain
  channel: string
  assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  runtimeAvailable: () => Promise<boolean>
  readSettings: () => { settings: { localLlm: { enabled: boolean; modelId: string } }; readable: boolean }
  allowedProviders: () => readonly string[] | null
  ensure: (modelId: string) => Promise<boolean>
  onReady: () => void
  onFailure: (error: unknown) => void
}): void {
  options.ipcMain.handle(options.channel, async (event) => {
    options.assertMainWindow(event)
    try {
      return {
        ok: await provisionExplicitLocalModel({
          runtimeAvailable: options.runtimeAvailable,
          readSettings: options.readSettings,
          allowedProviders: options.allowedProviders,
          ensure: options.ensure,
          onReady: options.onReady
        })
      }
    } catch (error) {
      options.onFailure(error)
      return { ok: false }
    }
  })
}
