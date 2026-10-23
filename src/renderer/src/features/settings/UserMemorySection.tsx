/**
 * UserMemorySection.tsx — Settings › Privacy › what Métis remembers about you (G57, CAP-29).
 * Two groups: preferences you stated (kept until you remove them) and what you are working on now (forgotten after a
 * while). Each row can be corrected or deleted; there is no way to add one here, you tell Métis in a question.
 */
import { useCallback, useEffect, useState } from 'react'
import type { UserMemoryItem, UserMemoryList } from '@shared/user-memory'
import { TextButton } from '../../components/ui'
import { ctl } from '../../ui/ctl'
import { userMemoryDetail } from './user-memory-view'

const GROUPS = [
  {
    kind: 'preference',
    title: 'Preferences',
    empty: 'Nothing yet. Say "remember that ..." or "call me ..." in a question.'
  },
  { kind: 'project-context', title: 'Working on now', empty: 'Nothing yet. Say "I\'m working on ..." in a question.' }
] as const

export function UserMemorySection(): JSX.Element {
  const [list, setList] = useState<UserMemoryList | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const refresh = useCallback((): void => {
    void window.toto.userMemory.list().then(setList)
  }, [])
  useEffect(refresh, [refresh])

  const act = async (work: () => Promise<{ ok: boolean }>): Promise<void> => {
    await work()
    setEditing(null)
    refresh()
  }
  const row = (item: UserMemoryItem): JSX.Element => (
    <div key={item.id} className="flex flex-col gap-1 px-1">
      {editing?.id === item.id ? (
        <div className="flex items-center gap-2">
          <input
            className={`${ctl} flex-1`}
            value={editing.text}
            maxLength={400}
            aria-label="Edit what Métis remembers"
            onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
          />
          <TextButton onClick={() => void act(() => window.toto.userMemory.correct(item.id, editing.text))}>
            Save
          </TextButton>
          <TextButton onClick={() => setEditing(null)}>Cancel</TextButton>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <p className="m-0 flex-1 text-[12px] font-medium text-[color:var(--cl-foreground)]">{item.text}</p>
          <TextButton onClick={() => setEditing({ id: item.id, text: item.text })}>Correct</TextButton>
          <TextButton onClick={() => void act(() => window.toto.userMemory.remove(item.id))}>Delete</TextButton>
        </div>
      )}
      <p className="m-0 text-[11px] leading-relaxed text-[color:var(--cl-muted-foreground)]">
        {userMemoryDetail(item, Date.now())}
      </p>
    </div>
  )

  if (!list || list.status === 'unavailable')
    return (
      <p className="m-0 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
        What Métis remembers about you appears here once you are signed in.
      </p>
    )
  return (
    <div className="mt-2 flex flex-col gap-3">
      {GROUPS.map((group) => {
        const items = list.items.filter((item) => item.kind === group.kind)
        return (
          <div key={group.kind} className="flex flex-col gap-2">
            <p className="m-0 px-1 text-[12px] font-medium text-[color:var(--cl-muted-foreground)]">{group.title}</p>
            {items.length ? (
              items.map(row)
            ) : (
              <p className="m-0 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">{group.empty}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}
