import { Blob, File } from 'node:buffer'

/**
 * Attach a captured screenshot to a Dust conversation so a vision-capable Dust agent can see the screen.
 *
 * Dust messages are plain text — an image is never inlined into the message. Instead the screenshot is
 * uploaded to the workspace as a file and referenced by a *content fragment* (`{ title, fileId }`),
 * attached either at conversation creation (`createConversation({ contentFragment })`) or to an existing
 * conversation (`postContentFragment(...)`). This module owns only the upload → fragment step; wiring it
 * into the two conversation paths lives in dust.ts.
 */

/** Structural subset of the @dust-tt/client DustAPI that attachScreenshot needs — narrow so tests can
 *  pass a stub and so this module never imports the whole client surface. */
export interface DustFileClient {
  files: { upload(file: Blob): Promise<{ id: string } | null | undefined> }
}

/** A file-backed Dust content fragment. `content`/`contentType` are intentionally omitted — the fileId
 *  variant of the Dust schema treats them as nullable-optional. */
export interface DustFileContentFragment {
  title: string
  fileId: string
}

export type AttachScreenshotResult =
  | { ok: true; contentFragment: DustFileContentFragment }
  | { ok: false; error: unknown }

/**
 * Upload a screenshot (bare base64 JPEG — no `data:` prefix, matching the capture pipeline) and return a
 * content fragment referencing it. Never throws: an upload failure is returned as `{ ok: false, error }`
 * so the caller can route it through the SAME auth-refresh / failover paths as any other Dust error
 * (an auth 401 on upload should refresh-and-replay, not dead-end the whole screen question).
 */
export async function attachScreenshot(
  api: DustFileClient,
  imageBase64: string
): Promise<AttachScreenshotResult> {
  try {
    const bytes = Buffer.from(imageBase64, 'base64')
    if (bytes.byteLength === 0) return { ok: false, error: new Error('Empty screenshot payload.') }
    const file = new File([bytes], 'screenshot.jpg', { type: 'image/jpeg' })
    const info = await api.files.upload(file)
    if (!info?.id) return { ok: false, error: new Error('Dust file upload returned no id.') }
    return { ok: true, contentFragment: { title: 'Screenshot', fileId: info.id } }
  } catch (error) {
    return { ok: false, error }
  }
}
