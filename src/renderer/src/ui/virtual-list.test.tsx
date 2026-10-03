import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VirtualList, virtualWindow } from './VirtualList'
import { MeetingRow } from '../components/RecallView'
import type { MeetingSummary } from '@shared/ipc'

describe('VirtualList', () => {
  it('renders only the viewport window for a 5,000-row fixture', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }))
    const html = renderToStaticMarkup(
      <VirtualList
        items={rows}
        getKey={(row) => row.id}
        estimateSize={() => 24}
        initialViewportHeight={240}
        overscan={2}
        className="h-full overflow-y-auto"
        renderItem={({ item, style, measureRef }) => (
          <div key={item.id} ref={measureRef} style={style} data-row={item.id}>
            {item.label}
          </div>
        )}
      />
    )

    expect(html).toContain('Row 0')
    expect(html).toContain('Row 11')
    expect(html).not.toContain('Row 4999')
    expect((html.match(/data-row=/g) ?? []).length).toBeLessThan(25)
  })

  it('keeps stable windows from measured or estimated row sizes', () => {
    expect(virtualWindow([10, 10, 10, 10, 10], 20, 10, 1)).toEqual({
      start: 1,
      end: 5,
      offsetTop: 10,
      totalSize: 50
    })
  })

  it('renders only a window of real History rows for a 5,000-row fixture', () => {
    const meetings: MeetingSummary[] = Array.from({ length: 5000 }, (_, i) => ({
      file: `meeting-${i}.md`,
      title: `History meeting ${i}`,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 28), 9, i % 60)).toISOString(),
      mode: 'standard',
      durationMin: 30,
      participants: [`Person ${i % 5}`],
      topics: [`Topic ${i % 7}`]
    }))

    const html = renderToStaticMarkup(
      <VirtualList
        items={meetings}
        getKey={(meeting) => meeting.file}
        estimateSize={() => 72}
        initialViewportHeight={360}
        overscan={3}
        className="h-full overflow-y-auto"
        renderItem={({ item, style, measureRef }) => (
          <div ref={measureRef} style={style} data-row={item.file}>
            <MeetingRow
              meeting={item}
              isSelected={false}
              isActive={false}
              isDeleting={false}
              isEditing={false}
              editingValue=""
              isRenaming={false}
              isOpen={false}
              error={null}
              indexStatus={null}
              indexError={null}
              hydration={undefined}
              onSelect={() => undefined}
              onOpen={() => undefined}
              onDownload={() => undefined}
              onToggleConnections={() => undefined}
              onTrash={() => undefined}
              onExport={() => undefined}
              onStartEdit={() => undefined}
              onEditingChange={() => undefined}
              onCommitEdit={() => undefined}
              onCancelEdit={() => undefined}
            />
          </div>
        )}
      />
    )

    expect(html).toContain('History meeting 0')
    expect(html).not.toContain('History meeting 4999')
    expect((html.match(/data-row=/g) ?? []).length).toBeLessThan(25)
  })
})
