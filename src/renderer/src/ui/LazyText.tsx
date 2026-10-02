import {
  useEffect,
  useRef,
  useState
} from 'react'

/**
 * Debounced text field — shows keystrokes instantly but only commits (which persists settings.json to
 * disk over IPC) ~350ms after typing stops, and on blur. Stops every keystroke from hitting disk.
 */
function useLazyText(
  value: string,
  onCommit: (v: string) => void
): { local: string; onChange: (v: string) => void; onBlur: () => void } {
  const [local, setLocal] = useState(value)
  const last = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // Sync only on EXTERNAL changes (not our own commits) so in-flight typing isn't reverted.
    if (value !== last.current) {
      last.current = value
      setLocal(value)
    }
  }, [value])
  const commit = (v: string): void => {
    last.current = v
    onCommit(v)
  }
  const onChange = (v: string): void => {
    setLocal(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(v), 350)
  }
  const onBlur = (): void => {
    if (timer.current) clearTimeout(timer.current)
    if (local !== last.current) commit(local)
  }
  return { local, onChange, onBlur }
}

export function LazyTextarea({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id,
  rows,
  spellCheck
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  rows?: number
  spellCheck?: boolean
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <textarea
      id={id}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
      rows={rows}
      spellCheck={spellCheck}
    />
  )
}

export function LazyInput({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  id,
  list,
  'aria-label': ariaLabel
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  /** Id of a sibling <datalist> — without it the model fields would lose their suggestion list when
   *  they moved onto this debounced input. */
  list?: string
  'aria-label'?: string
}): JSX.Element {
  const { local, onChange, onBlur } = useLazyText(value, onCommit)
  return (
    <input
      id={id}
      list={list}
      value={local}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={className}
    />
  )
}
