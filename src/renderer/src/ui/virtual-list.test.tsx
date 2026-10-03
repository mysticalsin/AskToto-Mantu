import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VirtualList, virtualWindow } from './VirtualList'

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
})
