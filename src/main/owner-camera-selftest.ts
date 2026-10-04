import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { app, systemPreferences } from 'electron'
import { CommandControl } from './command-control'
import { executeDesktopAction } from './desktop-adapters'

const REPORT_ENV = 'METIS_OWNER_CAMERA_REPORT'
const PHOTO_DIR_ENV = 'METIS_OWNER_CAMERA_DIR'
const APPROVED_ENV = 'METIS_OWNER_CAMERA_APPROVED'
const WEBCONTENTS_ENV = 'METIS_OWNER_CAMERA_WEBCONTENTS_ID'

type OwnerCameraSelftestReport = {
  schema: 1
  ticket: 'M2-0572'
  kind: 'owner-mac'
  result: 'PASS' | 'PRECONDITION' | 'FAIL'
  cameraDevicePresent: boolean | null
  approvalPromptShown: boolean
  explicitApprovalAccepted: boolean
  imageFilesCreated: number
  imageBytes: number
  imageDeleted: false
  reason?: string
}

async function imageFiles(dir: string): Promise<Array<{ name: string; size: number }>> {
  const files = await Promise.all((await readdir(dir))
    .filter((name) => /\.(png|jpe?g|heic)$/i.test(name))
    .map(async (name) => ({ name: basename(name), size: (await stat(resolve(dir, name))).size })))
  return files
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function writeReport(path: string, report: OwnerCameraSelftestReport): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

export async function runOwnerCameraSelftest(ownerWebContentsId: number): Promise<boolean> {
  const reportPath = process.env[REPORT_ENV]
  const photoDir = process.env[PHOTO_DIR_ENV]
  if (!reportPath && !photoDir) return false
  if (!reportPath || !photoDir) throw new Error(`${REPORT_ENV} and ${PHOTO_DIR_ENV} must be set together`)

  const report = (patch: Partial<OwnerCameraSelftestReport>): OwnerCameraSelftestReport => ({
    schema: 1,
    ticket: 'M2-0572',
    kind: 'owner-mac',
    result: 'FAIL',
    cameraDevicePresent: null,
    approvalPromptShown: false,
    explicitApprovalAccepted: false,
    imageFilesCreated: 0,
    imageBytes: 0,
    imageDeleted: false,
    ...patch
  })

  const cameraStatus = systemPreferences.getMediaAccessStatus('camera')
  if (cameraStatus !== 'granted') {
    await writeReport(reportPath, report({ result: 'PRECONDITION', reason: `camera grant is ${cameraStatus}` }))
    app.exit(0)
    return true
  }
  if (process.env[APPROVED_ENV] !== '1') {
    await writeReport(reportPath, report({ result: 'PRECONDITION', reason: 'explicit approval was not accepted' }))
    app.exit(0)
    return true
  }

  const before = new Set((await imageFiles(photoDir)).map((file) => file.name))
  let approvalPromptShown = false
  const controller = new CommandControl({
    execute: executeDesktopAction,
    onState: (state) => {
      if (state.proposalId) approvalPromptShown = true
    }
  })
  const proposal = controller.propose(
    { webContentsId: ownerWebContentsId, revision: 1 },
    { id: 'desktop.photo_booth_capture', args: {} }
  )
  process.env[WEBCONTENTS_ENV] = String(ownerWebContentsId)
  let confirmation: Awaited<ReturnType<CommandControl['confirm']>>
  try {
    confirmation = await controller.confirm({ ...proposal, webContentsId: ownerWebContentsId })
  } finally {
    delete process.env[WEBCONTENTS_ENV]
  }
  const after = (await imageFiles(photoDir)).filter((file) => !before.has(file.name))
  const imageBytes = after.reduce((sum, file) => sum + file.size, 0)

  await writeReport(reportPath, report({
    result: confirmation.ok && after.length === 1 && imageBytes > 0 ? 'PASS' : 'FAIL',
    cameraDevicePresent: after.length > 0 || /camera-count=/.test(JSON.stringify(confirmation)),
    approvalPromptShown,
    explicitApprovalAccepted: true,
    imageFilesCreated: after.length,
    imageBytes,
    reason: confirmation.ok ? undefined : confirmation.reason
  }))
  app.exit(0)
  return true
}
