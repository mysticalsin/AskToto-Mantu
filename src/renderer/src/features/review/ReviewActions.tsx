// @ts-nocheck
import { AlertCircle, Check, ListTree, Mail, RotateCcw, Send } from 'lucide-react'
import { Markdown } from '../../components/Markdown'
import { Chip, TextButton } from '../../components/ui'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { nextStepPushed, coldCallHasPeopleToFollowUp } from './review-helpers'

export function ReviewActionPanels(props: any): JSX.Element {
  const { recapText, recap, editingRecap, coldCall, confidentialFlag, crmPushed, pushOpen, setPushOpen, setPushState, pushState, bidstackConnected, bidstackTools, pushTool, setPushTool, crmPayload, sendToCrm, clickupConn, clickupOpen, setClickupOpen, clickupState, setClickupState, clickupDestName, clickupResolving, ensureClickupDest, sendToClickup, taskConnections, nextStepsOpen, setNextStepsOpen, nextStepsData, nextStepsLoading, nextStepsFetchError, itemChecked, setItemChecked, itemTitle, setItemTitle, connChecked, setConnChecked, connTool, setConnTool, connTarget, setConnTarget, stepStatus, pushingNextSteps, openNextSteps, nextStepArgs, confirmNextSteps } = props
  return (
    <>
      {recapText && !recap?.error && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <Send size={12} /> CRM
            </div>
            {bidstackConnected && !pushOpen && !crmPushed && !confidentialFlag && (
              <Chip onClick={() => setPushOpen(true)} variant="accent">
                <Send size={13} /> Push to CRM
              </Chip>
            )}
            {confidentialFlag && bidstackConnected && (
              <span className="text-[11px] text-[color:var(--color-ink-3)]">CRM push blocked (confidential)</span>
            )}
          </div>

          {!bidstackConnected ? (
            <div className="text-[12px] leading-snug text-[color:var(--color-ink-3)]">
              Connect Polo Pre-Sales in Settings → Mantu Intelligence to push this recap to your CRM.
            </div>
          ) : crmPushed ? (
            <div className="flex items-center gap-1.5 text-[13px] text-[var(--color-success)]">
              <Check size={13} /> Pushed to Polo Pre-Sales.
            </div>
          ) : pushOpen ? (
            <div className="flex flex-col gap-2">
              {bidstackTools && bidstackTools.length > 0 ? (
                <label className="flex flex-col gap-1 text-[11px] text-[color:var(--color-ink-3)]">
                  Polo Pre-Sales tool
                  <select
                    value={pushTool}
                    onChange={(e) => setPushTool(e.target.value)}
                    className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[13px] text-[color:var(--color-ink)]"
                  >
                    {bidstackTools.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="text-[11px] text-[color:var(--color-danger)]">
                  Polo Pre-Sales has no tools in this key's scope, so there's nothing to push to. Check the key's
                  scopes in Settings.
                </div>
              )}

              {/* Exact payload preview — shown before anything is sent, same review-first discipline as
                  the follow-up draft above. Deliberately thin: title/date/summary only, no transcript. */}
              <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[12px]">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                  Payload preview
                </div>
                <div className="flex flex-col gap-1 text-[color:var(--color-ink-2)]">
                  <div>
                    <span className="text-[color:var(--color-ink-3)]">Title: </span>
                    {crmPayload.title}
                  </div>
                  <div>
                    <span className="text-[color:var(--color-ink-3)]">Date: </span>
                    {crmPayload.date}
                  </div>
                  <div className="text-[color:var(--color-ink-3)]">Summary:</div>
                  <div className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] p-2 text-[color:var(--color-ink)]">
                    {crmPayload.summary || '(empty)'}
                  </div>
                </div>
              </div>

              {pushState.phase === 'error' && pushState.error && (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  <span>{pushState.error}</span>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                {/* Only render Confirm push when there is a tool to push to. With a zero-tool key scope the
                    tool picker never renders and pushTool stays '', so sendToCrm() would return at its
                    `if (!pushTool)` guard — a dead click with no feedback. Gating the Chip here leaves only
                    Cancel plus the "reported no tools" note, so the button is never a silent no-op. */}
                {pushTool && (
                  <Chip
                    onClick={() => void sendToCrm()}
                    variant="accent"
                    disabled={pushState.phase === 'sending'}
                  >
                    {pushState.phase === 'sending' ? <InlineOrb kind="connecting" /> : <Send size={13} />}
                    {pushState.phase === 'sending' ? 'Pushing…' : 'Confirm push'}
                  </Chip>
                )}
                <TextButton
                  onClick={() => {
                    setPushOpen(false)
                    setPushState({ phase: 'idle', error: null })
                  }}
                  disabled={pushState.phase === 'sending'}
                >
                  Cancel
                </TextButton>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {recapText && !recap?.error && !editingRecap && clickupConn && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <Send size={12} /> ClickUp
            </div>
            {!clickupOpen && clickupState.phase !== 'sent' && !confidentialFlag && (
              <Chip
                onClick={() => {
                  setClickupOpen(true)
                  void ensureClickupDest()
                }}
                variant="accent"
              >
                <Send size={13} /> Push to ClickUp
              </Chip>
            )}
            {confidentialFlag && (
              <span className="text-[11px] text-[color:var(--color-ink-3)]">ClickUp push blocked (confidential)</span>
            )}
          </div>

          {clickupState.phase === 'sent' ? (
            <div className="flex flex-col gap-1 text-[13px] text-[var(--color-success)]">
              <div className="flex items-center gap-1.5">
                <Check size={13} /> Created in {clickupState.destinationName || clickupDestName || 'ClickUp'}.
              </div>
              {clickupState.taskUrl ? (
                <a href={clickupState.taskUrl} className="text-[11px] text-[color:var(--color-ink-2)] underline" target="_blank" rel="noreferrer">
                  {clickupState.taskUrl}
                </a>
              ) : null}
            </div>
          ) : clickupOpen ? (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] text-[color:var(--color-ink-2)]">
                {clickupResolving
                  ? 'Finding the ClickUp list…'
                  : clickupDestName
                    ? `Task in ${clickupDestName}`
                    : 'ClickUp could not name the destination.'}
              </div>
              <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[12px]">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                  Payload preview
                </div>
                <div className="flex flex-col gap-1 text-[color:var(--color-ink-2)]">
                  <div>
                    <span className="text-[color:var(--color-ink-3)]">Name: </span>
                    {crmPayload.title}
                  </div>
                  <div className="text-[color:var(--color-ink-3)]">Description:</div>
                  <div className="scroll-thin max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white/[0.03] p-2 text-[color:var(--color-ink)]">
                    {crmPayload.summary || '(empty)'}
                  </div>
                </div>
              </div>
              {clickupState.phase === 'error' && clickupState.error && (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  <span>{clickupState.error}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                {clickupDestName && !clickupResolving ? (
                  <Chip
                    onClick={() => void sendToClickup()}
                    variant="accent"
                    disabled={clickupState.phase === 'sending'}
                  >
                    {clickupState.phase === 'sending' ? <InlineOrb kind="connecting" /> : <Send size={13} />}
                    {clickupState.phase === 'sending' ? 'Pushing…' : 'Confirm push'}
                  </Chip>
                ) : null}
                <TextButton
                  onClick={() => {
                    setClickupOpen(false)
                    setClickupState({ phase: 'idle', error: null })
                  }}
                  disabled={clickupState.phase === 'sending'}
                >
                  Cancel
                </TextButton>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {recapText && !recap?.error && !editingRecap && taskConnections.length > 0 && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <ListTree size={12} /> Next steps
            </div>
            {!nextStepsOpen && !confidentialFlag && (
              <Chip onClick={() => void openNextSteps()} variant="accent">
                <ListTree size={13} /> Book next steps
              </Chip>
            )}
            {confidentialFlag && (
              <span className="text-[11px] text-[color:var(--color-ink-3)]">Task push blocked (confidential)</span>
            )}
          </div>

          {nextStepsOpen && (
            <div className="flex flex-col gap-3">
              {nextStepsLoading ? (
                <AgentStatus kind="searching" size="inline" caption />
              ) : nextStepsFetchError ? (
                <div className="flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  <span>{nextStepsFetchError}</span>
                </div>
              ) : nextStepsData && nextStepsData.length === 0 ? (
                <div className="text-[12px] leading-snug text-[color:var(--color-ink-3)]">
                  No action items found in this recap.
                </div>
              ) : nextStepsData ? (
                <>
                  {/* Item checklist — each pre-checked, title editable before it becomes a real task title. */}
                  <div className="flex flex-col gap-1.5">
                    {nextStepsData.map((item, i) => (
                      <label key={i} className="flex items-start gap-2 text-[12px]">
                        <input
                          type="checkbox"
                          checked={itemChecked[i] ?? true}
                          onChange={(e) => setItemChecked((s) => ({ ...s, [i]: e.target.checked }))}
                          className="mt-1 shrink-0"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <input
                            value={itemTitle[i] ?? item.text}
                            onChange={(e) => setItemTitle((s) => ({ ...s, [i]: e.target.value }))}
                            disabled={!(itemChecked[i] ?? true)}
                            className="w-full rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1 text-[12px] text-[color:var(--color-ink)] disabled:opacity-50"
                          />
                          {(item.owner || item.dueDateText) && (
                            <span className="text-[11px] text-[color:var(--color-ink-3)]">
                              {item.owner ? `Owner: ${item.owner}` : ''}
                              {item.owner && item.dueDateText ? ' · ' : ''}
                              {item.dueDateText ? `Mentioned due: ${item.dueDateText}` : ''}
                            </span>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Connection picker — a next step can go to more than one connected task manager. */}
                  <div className="flex flex-col gap-2">
                    {taskConnections.map((conn) => {
                      const checked = connChecked[conn.id] ?? true
                      const tool = connTool[conn.id] || conn.tools[0] || ''
                      return (
                        <div key={conn.id} className="flex flex-col gap-1.5 rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5">
                          <label className="flex items-center gap-2 text-[12px] font-medium text-[color:var(--color-ink)]">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => setConnChecked((s) => ({ ...s, [conn.id]: e.target.checked }))}
                            />
                            {conn.label}
                          </label>
                          {checked && (
                            <div className="flex flex-col gap-1.5 pl-6">
                              {conn.kind === 'clickup' ? (
                                <div className="text-[11px] text-[color:var(--color-ink-2)]">
                                  {clickupResolving
                                    ? 'Finding the ClickUp list…'
                                    : clickupDestName
                                      ? `Task in ${clickupDestName}`
                                      : 'ClickUp could not name the destination.'}
                                </div>
                              ) : (
                                <>
                                  {conn.tools.length > 0 ? (
                                    <select
                                      value={tool}
                                      onChange={(e) => setConnTool((s) => ({ ...s, [conn.id]: e.target.value }))}
                                      className="no-drag rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[12px] text-[color:var(--color-ink)]"
                                    >
                                      {conn.tools.map((t) => (
                                        <option key={t} value={t}>
                                          {t}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <div className="text-[11px] text-[var(--color-danger)]">
                                      {conn.label} has no tools in this key's scope, so there's nothing to push to.
                                    </div>
                                  )}
                                  <input
                                    value={connTarget[conn.id] || ''}
                                    onChange={(e) => setConnTarget((s) => ({ ...s, [conn.id]: e.target.value }))}
                                    placeholder={`${conn.label} project ID (optional)`}
                                    className="w-full rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.02] px-2 py-1.5 text-[12px] text-[color:var(--color-ink)]"
                                  />
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Payload preview — one card per checked item × checked connection, exactly what will be
                      sent. Same review-first discipline as the CRM payload preview above. */}
                  <div className="flex flex-col gap-1.5">
                    {nextStepsData.map((item, i) => {
                      if (!(itemChecked[i] ?? true)) return null
                      return taskConnections
                        .filter((c) => connChecked[c.id] ?? true)
                        .map((conn) => {
                          const args = nextStepArgs(item, i, conn.id)
                          const key = `${i}:${conn.id}`
                          const status = stepStatus[key]
                          const done = nextStepPushed(status?.phase ?? 'idle', conn.id, args)
                          return (
                            <div key={key} className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-2.5 text-[12px]">
                              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
                                <span>{conn.label}</span>
                                {done ? (
                                  <span className="flex items-center gap-1 text-[var(--color-success)]">
                                    <Check size={11} /> Sent
                                  </span>
                                ) : status?.phase === 'sending' ? (
                                  <span className="flex items-center gap-1 text-[color:var(--color-ink-3)]">
                                    <InlineOrb kind="connecting" /> Sending
                                  </span>
                                ) : null}
                              </div>
                              <div className="text-[color:var(--color-ink)]">{args.title}</div>
                              {conn.kind === 'clickup' && clickupDestName ? (
                                <div className="mt-0.5 text-[11px] text-[color:var(--color-ink-3)]">Task in {clickupDestName}</div>
                              ) : null}
                              <div className="mt-0.5 whitespace-pre-wrap text-[color:var(--color-ink-2)]">{args.description}</div>
                              {status?.phase === 'error' && status.error && (
                                <div className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--color-danger)]">
                                  <AlertCircle size={12} className="mt-px shrink-0" />
                                  <span>{status.error}</span>
                                </div>
                              )}
                            </div>
                          )
                        })
                    })}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Chip onClick={() => void confirmNextSteps()} variant="accent" disabled={pushingNextSteps}>
                      {pushingNextSteps ? <InlineOrb kind="connecting" /> : <ListTree size={13} />}
                      {pushingNextSteps ? 'Pushing…' : 'Confirm push'}
                    </Chip>
                    <TextButton onClick={() => setNextStepsOpen(false)}>Cancel</TextButton>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </section>
      )}
    </>
  )
}
