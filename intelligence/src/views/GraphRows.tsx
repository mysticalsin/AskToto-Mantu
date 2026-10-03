import { memo } from 'react'
import type { DashboardData, GraphNode } from '../types/data'

type GoingColdItem = NonNullable<DashboardData['going_cold']>[number]

export type GraphBridgeRowItem = {
  id: string
  label: string
  account?: string
  spans: number
  communityLabels: string[]
}

export const GoingColdRow = memo(function GoingColdRow({
  item,
  onFocus
}: {
  item: GoingColdItem
  onFocus: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onFocus(item.nodeId)}
      className="block w-full rounded-md bg-black/20 px-2 py-1.5 text-left hover:bg-white/5"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium text-white/85">{item.label}</span>
        {item.account && <span className="truncate text-[10px] text-white/35">{item.account}</span>}
        <span
          className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ color: item.daysQuiet > 45 ? '#f7768e' : '#e0af68', background: 'rgba(255,255,255,0.06)' }}
        >
          {item.daysQuiet}d quiet
        </span>
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-white/50">{item.hook}</div>
    </button>
  )
})

export const RelationshipRiskRow = memo(function RelationshipRiskRow({
  node,
  onFocus
}: {
  node: GraphNode
  onFocus: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onFocus(node.id)}
      className="block w-full rounded-md bg-black/20 px-2 py-1.5 text-left hover:bg-white/5"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium text-white/85">{node.label}</span>
        {node.account && node.account !== node.label && (
          <span className="truncate text-[10px] text-white/35">{node.account}</span>
        )}
        <span className="ml-auto shrink-0 rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200/90">
          {node.single_threaded ? 'single-threaded' : 'unmapped'}
        </span>
      </div>
    </button>
  )
})

export const BridgeRow = memo(function BridgeRow({
  bridge,
  onFocus
}: {
  bridge: GraphBridgeRowItem
  onFocus: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onFocus(bridge.id)}
      className="block w-full rounded-md bg-black/20 px-2 py-1.5 text-left hover:bg-white/5"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-medium text-white/85">{bridge.label}</span>
        {bridge.account && bridge.account !== bridge.label && (
          <span className="truncate text-[10px] text-white/35">{bridge.account}</span>
        )}
        <span className="ml-auto shrink-0 rounded-full bg-[var(--color-mantu-light)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-mantu-light)]">
          {bridge.spans} groups
        </span>
      </div>
      <div className="mt-0.5 truncate text-[11px] leading-snug text-white/50">
        connects {bridge.communityLabels.join(' · ')}
      </div>
    </button>
  )
})
