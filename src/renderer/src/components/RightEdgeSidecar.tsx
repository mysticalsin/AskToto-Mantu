export const RIGHT_EDGE_TAB_WIDTH = 52
export const RIGHT_EDGE_DRAWER_WIDTH = 360

export function RightEdgeSidecar({
  open,
  onOpen,
  onClose
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className={'right-edge-sidecar' + (open ? ' right-edge-sidecar--open' : '')}>
      <button
        type="button"
        aria-label="Open Métis"
        aria-expanded={open}
        onClick={onOpen}
        className="right-edge-sidecar__tab no-drag focus-ring"
        style={{ width: RIGHT_EDGE_TAB_WIDTH }}
      >
        Métis
      </button>
      {open ? (
        <aside
          role="complementary"
          aria-label="Métis command"
          className="right-edge-sidecar__drawer"
          style={{ width: RIGHT_EDGE_DRAWER_WIDTH }}
        >
          <div className="right-edge-sidecar__drawer-scroll">
            <div className="right-edge-sidecar__heading">Métis command</div>
            <p>Command controls will appear here.</p>
            <button type="button" onClick={onClose} className="no-drag focus-ring">Close</button>
          </div>
        </aside>
      ) : null}
    </div>
  )
}
