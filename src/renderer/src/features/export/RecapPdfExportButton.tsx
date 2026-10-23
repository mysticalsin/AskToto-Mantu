import { useState } from 'react'
import { FileText } from 'lucide-react'
import { InlineOrb } from '../../components/AgentStatus'
import { TextButton } from '../../components/ui'
import { useExportNotice } from './ExportReceiptNotice'

/** "Export PDF" for a recap. The save dialog, destination preview and conflict choice are native dialogs
 *  owned by main; this only shows the busy state and the resulting "Exported to ..." receipt notice. */
export function RecapPdfExportButton({ markdown, title }: { markdown: string; title?: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const notice = useExportNotice()
  const run = (): void => {
    if (!markdown) return
    setBusy(true)
    window.toto
      .recapPdf({ markdown, title })
      .then(notice.report)
      .catch(notice.fail)
      .finally(() => setBusy(false))
  }
  return (
    <>
      <TextButton onClick={run} disabled={busy} title="Save this summary as a PDF">
        {busy ? <InlineOrb kind="loading" /> : <FileText size={11} />}
        Export PDF
      </TextButton>
      {notice.node && <div className="basis-full">{notice.node}</div>}
    </>
  )
}
