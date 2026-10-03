// @ts-nocheck
import { AlertCircle, ArrowLeft, Check, ChevronDown, Clock, Copy, Download, EarOff, FileText, FolderOpen, ListTree, Lock, Pencil, Play, RotateCcw, Save, Sparkles, Trash2, PhoneCall, Mail, Send, X } from 'lucide-react'
import { isNonSpeechLine } from '@shared/transcript-filter'
import { talkStats } from '@shared/talkstats'
import { Markdown } from '../../components/Markdown'
import { Chip, TextButton, Spinner } from '../../components/ui'
import { AgentStatus, InlineOrb } from '../../components/AgentStatus'
import { ReviewEntityStrip } from '../../components/ReviewEntityStrip'
import { VirtualList } from '../../ui/VirtualList'
import { accelLabel } from '../../lib/keys'
import {
  INCOMPLETE_RECAP_COPY,
  coldCallHasPeopleToFollowUp,
  RecapBody,
  TranscriptRow,
  formatDuration,
  formatDurationMin,
  friendlyDate,
  groupByDate,
  meetingTime,
  saveStatusLine
} from './review-helpers'
import { ReviewActionPanels } from './ReviewActions'

export function ReviewLayout(props: any): JSX.Element {
  const { coldCall, onGenerateFollowup, followupDraft, followupText, setFollowupText, followupCopied, copyFollowup, openFollowupInMail, createOutlookDraft, outlookDraftSession, outlookDraftLocalError, mailError, outlook, winsToggle, outlookDraftIntentSnapshot, outlookDraftLifecycle, outlookDraftMeeting, outlookDraftSubject, setOutlookDraftLocalError, setFollowupEdited, mode, recap, recapStatus, lines, savedPath, saveError, saveAttempts, maxSaveAttempts, saveGaveUp, meetingMeta, onOpenFolder, onSave, onDiscard, onDone, onResume, onRetryRecap, onGenerateRecap, onOpenPastMeeting, isPastMeeting, recapUnavailable, finishingTranscript, copied, notesCopied, jsonCopied, exportError, transcriptOpen, setTranscriptOpen, confidentialFlag, confidentialBusy, toggleConfidential, debrief, setDebrief, debriefState, saveDebrief, recentMeetings, summaryRef, editingRecap, recapDraft, setRecapDraft, recapSaving, recapEditError, recapText, startEditRecap, cancelEditRecap, saveRecap, guardRecapEditNavigation, speechLines, durationSec, speakerCountLabel, copyError, copy, copyNotes, exportJson, exportPdf, pdfBusy } = props
  return (
    <div className="flex flex-col gap-3">
      {meetingMeta && (
        <div className="mb-0.5">
          <div className="font-ui text-[15px] font-semibold text-[color:var(--color-ink)]" aria-label="Review meeting title">{meetingMeta.title}</div>
          <div className="mt-0.5 text-[12px] text-[color:var(--color-ink-3)]">{meetingMeta.date}</div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[11px] text-[color:var(--color-ink-2)]">
        <div className="flex items-center gap-2">
          {durationSec > 0 && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5">Duration {formatDuration(durationSec)}</span>
          )}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5">
            {speakerCountLabel}
          </span>
          {/* Talk ratio — word share over real speech lines. Amber past 70%: in a client meeting,
              the one selling should not be the one talking. Details on hover. */}
          {(() => {
            const s = talkStats(lines.filter((l) => !isNonSpeechLine(l.text)))
            if (s.youShare === null) return null
            const pct = Math.round(s.youShare * 100)
            return (
              <span
                className="rounded-full bg-white/[0.06] px-2 py-0.5"
                title={`${s.youWords} of ${s.youWords + s.themWords} words · longest monologue ${formatDuration(s.longestMonologueSec)} · they asked ${s.themQuestions} question${s.themQuestions === 1 ? '' : 's'}`}
                style={pct >= 70 ? { color: 'var(--color-warn)' } : undefined}
              >
                You spoke {pct}%
              </span>
            )
          })()}
        </div>
        <div className="flex items-center gap-1.5">
          {onResume && (
            <Chip
              icon={Play}
              onClick={() => {
                void (async () => {
                  if (await guardRecapEditNavigation()) onResume()
                })()
              }}
              variant="accent"
            >
              Resume session
            </Chip>
          )}
          {onSave && (
            // A missing recap must not block saving captured speech: keyless, cancelled-before-token and
            // hollow-summary sessions still have an ASR transcript worth keeping.
            <TextButton
              icon={Save}
              onClick={onSave}
              disabled={lines.length === 0 || !!savedPath || !!recap?.streaming}
            >
              Save
            </TextButton>
          )}
          {onDiscard && (
            <TextButton icon={Trash2} onClick={onDiscard} title="Discard this meeting without keeping it">Disregard</TextButton>
          )}
          {onDone && (
            <Chip
              icon={isPastMeeting ? ArrowLeft : RotateCcw}
              onClick={() => {
                void (async () => {
                  if (await guardRecapEditNavigation()) onDone()
                })()
              }}
              variant="accent"
            >
              {isPastMeeting ? 'Back to history' : 'New meeting'}
            </Chip>
          )}
        </div>
      </div>

      {saveError && !savedPath && (
        <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-3 py-2 text-[12px] text-[var(--color-danger)]">
          <div>Couldn't save the transcript: {saveError}</div>
          {(() => {
            if (saveAttempts === undefined || maxSaveAttempts === undefined) return null
            const status = saveStatusLine(saveAttempts, maxSaveAttempts, saveGaveUp ?? false)
            return status ? <div className="mt-1 text-[11px] opacity-80">{status}</div> : null
          })()}
        </div>
      )}
      {savedPath && !meetingMeta && (
        <button
          type="button"
          aria-label="Open saved transcript folder"
          onClick={onOpenFolder}
          className="no-drag focus-ring flex items-center gap-2 rounded-xl border border-[var(--color-success)]/30 bg-[var(--color-success)]/10 px-3 py-2 text-left text-[12px] hover:bg-[var(--color-success)]/16"
        >
          <FolderOpen size={14} className="text-[var(--color-success)]" />
          <span className="flex-1 text-[color:var(--color-ink-2)]">
            Saved to your meetings folder for Dust follow-up.
          </span>
          <span className="font-medium text-[var(--color-success)]">Open</span>
        </button>
      )}

      {/* Task MI-5 — confidential flag: excludes this meeting from every published wiki page (note
          card, entity timelines/current-facts, indexes). Available for both a just-saved live meeting
          and a reopened past one — anything with a real savedPath. */}
      {savedPath && (
        <button
          type="button"
          onClick={() => void toggleConfidential()}
          disabled={confidentialBusy}
          aria-pressed={confidentialFlag}
          className={[
            'no-drag focus-ring flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[12px] disabled:opacity-60',
            confidentialFlag
              ? 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10'
              : 'border-[var(--color-hair-soft)] bg-white/[0.02] hover:bg-white/[0.05]'
          ].join(' ')}
        >
          <Lock size={13} className={confidentialFlag ? 'text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'} />
          <span className="flex-1 text-[color:var(--color-ink-2)]">
            {confidentialFlag
              ? 'Confidential: excluded from published intelligence.'
              : 'Confidential: exclude from published intelligence'}
          </span>
          <span className={confidentialFlag ? 'font-medium text-[var(--color-danger)]' : 'text-[color:var(--color-ink-3)]'}>
            {confidentialFlag ? 'On' : 'Off'}
          </span>
        </button>
      )}

      {/* Entities in this meeting (Task MI-3) — the moment-of-truth correction strip. Renders nothing
          until the meeting's extraction lands (and never when the brain is off), so it can't shift the
          layout for anyone else; dismissible; blocks no other Review interaction. */}
      <ReviewEntityStrip file={savedPath} />

      {/* 90-SECOND DEBRIEF — the unsaid, captured while it's still warm. Live reviews only (a past
          meeting's moment has passed). Stored inside the saved meeting file: same encryption, same
          retention, same deletion; the brain folds it into signals on re-ingest. */}
      {savedPath && !meetingMeta && (
        <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <EarOff size={12} /> 90-second debrief, off the record
          </div>
          {debriefState === 'saved' ? (
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--color-ink-2)]">
              <Check size={13} className="text-[var(--color-success)]" />
              Saved with the meeting. It feeds your intelligence brain, never a follow-up email.
            </div>
          ) : (
            <>
              <textarea
                value={debrief}
                onChange={(e) => setDebrief(e.target.value)}
                rows={2}
                placeholder="What wasn't said out loud? Hallway remarks, hesitation, your gut read…"
                className="no-drag focus-ring w-full resize-none rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
              />
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[10px] text-[color:var(--color-ink-3)]">
                  {debriefState === 'error' ? 'Could not save. Try again.' : 'Impressions, not transcript. 90 seconds, then move on.'}
                </span>
                <TextButton onClick={() => void saveDebrief()} disabled={!debrief.trim() || debriefState === 'saving'}>
                  {debriefState === 'saving' ? <InlineOrb kind="writing" /> : <Save size={11} />}
                  Save debrief
                </TextButton>
              </div>
            </>
          )}
        </div>
      )}

      <section ref={summaryRef} tabIndex={-1} aria-live="polite" aria-atomic="false">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <ListTree size={12} /> Summary
          </div>
          {editingRecap ? (
            // Edit mode toolbar: Save / Cancel. Replaces Copy/Export, which don't apply mid-edit.
            <div className="flex items-center gap-1">
              <Chip onClick={() => void saveRecap()} variant="accent" disabled={recapSaving}>
                {recapSaving ? <InlineOrb kind="writing" /> : <Check size={13} />}
                {recapSaving ? 'Saving' : 'Save'}
              </Chip>
              <TextButton onClick={cancelEditRecap} disabled={recapSaving}>
                <X size={11} /> Cancel
              </TextButton>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {/* Retroactive recap generation — a past meeting saved/imported without one (a keyless
                  import, or one from before this button existed). Hidden once there's a recap OR an error
                  showing (the error view below already has its own Retry). Disabled mid-stream so a second
                  click can't self-cancel the in-flight generation. */}
              {isPastMeeting && !recapText && !recap?.error && onGenerateRecap && (
                <Chip onClick={onGenerateRecap} variant="accent" disabled={recap?.streaming}>
                  {recap?.streaming ? <AgentStatus kind="writing" size="inline" caption /> : <Sparkles size={13} />}
                  {recap?.streaming ? null : 'Generate recap'}
                </Chip>
              )}
              {/* Edit — past meetings only (a live session's recap is still owned by the ask state, and may
                  be streaming/retryable). Available even when the recap is empty, so a meeting saved without
                  one can still be annotated. */}
              {isPastMeeting && !recap?.error && (
                <TextButton onClick={startEditRecap} title="Edit these notes">
                  <Pencil size={11} /> Edit
                </TextButton>
              )}
              {recapText && !recap?.error && (
                <>
                  {/* Accent-filled so the primary "copy the recap" action is unmissable on the review screen. */}
                  <Chip onClick={copyNotes} variant="accent">
                    {notesCopied ? <Check size={13} className="text-white" /> : <Copy size={13} />}
                    {notesCopied ? 'Copied' : 'Copy Summary'}
                  </Chip>
                  {/* Regenerate — re-run the recap from the same transcript when the generated summary is wrong
                      or thin. Same handler as the error-state Retry (onRetryRecap): a live meeting re-runs its
                      recap, a past meeting regenerates + overwrites the saved one. Focus the section first
                      because this button unmounts the instant regeneration clears recapText (mirrors Retry). */}
                  {onRetryRecap && (
                    <TextButton
                      onClick={() => {
                        summaryRef.current?.focus()
                        onRetryRecap?.()
                      }}
                      disabled={recap?.streaming}
                      title="Regenerate this summary from the transcript"
                    >
                      {recap?.streaming ? <InlineOrb kind="writing" /> : <RotateCcw size={11} />}
                      {recap?.streaming ? 'Regenerating' : recapStatus === 'incomplete' ? 'Retry summary' : 'Regenerate'}
                    </TextButton>
                  )}
                  <TextButton onClick={exportJson} title="Copy structured JSON (decisions + action items) for Jira/Asana/Notion">
                    {jsonCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <Download size={11} />}
                    {jsonCopied ? 'Copied' : 'Export JSON'}
                  </TextButton>
                  <TextButton onClick={exportPdf} disabled={pdfBusy} title="Save this summary as a PDF">
                    {pdfBusy ? <InlineOrb kind="loading" /> : <FileText size={11} />}
                    Export PDF
                  </TextButton>
                </>
              )}
            </div>
          )}
        </div>
        {exportError && <div className="mb-1.5 text-[11px] text-[var(--color-danger)]">{exportError}</div>}
        {recapStatus === 'incomplete' && (
          <div className="mb-2 rounded-lg border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 px-2.5 py-2 text-[12px] text-[color:var(--color-ink-2)]">
            {INCOMPLETE_RECAP_COPY}
          </div>
        )}
        {editingRecap ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={recapDraft}
              autoFocus
              onChange={(e) => setRecapDraft(e.target.value)}
              onKeyDown={(e) => {
                // Escape cancels; stopPropagation keeps it from bubbling to App's global Escape handler
                // (which would otherwise act on the whole overlay). Cmd/Ctrl+Enter saves, matching the
                // app's other commit shortcuts.
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  cancelEditRecap()
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.stopPropagation()
                  e.preventDefault()
                  void saveRecap()
                }
              }}
              rows={14}
              maxLength={20000}
              spellCheck={false}
              aria-label="Edit meeting notes"
              className="scroll-thin no-drag w-full resize-y rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[13px] leading-relaxed text-[color:var(--color-ink)] focus:outline-none"
            />
            {recapEditError && <div className="text-[11px] text-[var(--color-danger)]">{recapEditError}</div>}
            <div className="text-[11px] text-[color:var(--color-ink-3)]">
              Markdown supported. Changes are saved to this meeting. {accelLabel('CommandOrControl+Return')} to save, Esc to cancel.
            </div>
          </div>
        ) : recap?.error ? (
          <div className="flex flex-col gap-2">
            {/* Substantial streamed notes stay visible — a trailing idle-timeout used to hide them
                behind the error alone and autosave used to wipe them. Show what we have + Retry. */}
            {!!recapText.trim() && (
              <div className="opacity-90">
                <RecapBody text={recapText} mode={mode} />
              </div>
            )}
            <div className="text-[13px] text-[var(--color-danger)]">{recap.error}</div>
            {/* Scoped retry — replays just the recap request. Previously the only recovery was
                "New meeting", which throws away the whole saved transcript. */}
            {onRetryRecap && (
              <div className="flex items-center gap-1.5">
                <TextButton
                  icon={RotateCcw}
                  onClick={() => {
                    summaryRef.current?.focus()
                    onRetryRecap?.()
                  }}
                >
                  Retry summary
                </TextButton>
              </div>
            )}
          </div>
        ) : recapText ? (
          <RecapBody text={recapText} mode={mode} />
        ) : recap?.streaming ? (
          // A past meeting's retroactive "Generate recap" (or a just-finished import) is in flight —
          // recap here is recapGen's live streaming answer, not the static (still-empty) saved recap.
          <AgentStatus kind="writing" size="hero" />
        ) : recapStatus === 'incomplete' ? (
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[color:var(--color-ink-2)]">No summary text was generated.</div>
            {onRetryRecap && (
              <div className="flex items-center gap-1.5">
                <TextButton icon={RotateCcw} onClick={onRetryRecap}>Retry summary</TextButton>
              </div>
            )}
          </div>
        ) : isPastMeeting ? (
          // A past meeting saved without a recap (e.g. a keyless summary failure) and nothing generating
          // right now. Not a spinner — the work is long over; offer to add notes instead.
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No notes saved for this meeting. Select Edit to add some.
          </div>
        ) : !recap && lines.length === 0 ? (
          <div className="text-[13px] text-[color:var(--color-ink-2)]">
            No speech was captured this session.
          </div>
        ) : recapUnavailable ? (
          // No AI provider configured — the recap was never requested (see App.tsx maybeFireRecap), so
          // without this branch a transcript with no recap would fall through to the spinner below and
          // spin forever. Neutral, not an error: transcription/recording still worked.
          <div className="flex flex-col gap-2">
            <div className="text-[13px] text-[color:var(--color-ink-2)]">{recapUnavailable.message}</div>
            {recapUnavailable.onOpenSettings && (
              <div className="flex items-center gap-1.5">
                <TextButton onClick={recapUnavailable.onOpenSettings}>
                  Open Settings
                </TextButton>
              </div>
            )}
          </div>
        ) : finishingTranscript ? (
          <div className="flex items-center gap-2 py-1 text-[13px] text-[color:var(--color-ink-2)]">
            <Spinner size={13} /> finishing transcript…
          </div>
        ) : (
          <AgentStatus kind="writing" size="hero" />
        )}
      </section>

      {coldCall && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <PhoneCall size={12} /> Cold call coaching
            </div>
            {coldCall.coaching?.error && coldCall.onRetryCoaching && (
              <TextButton icon={RotateCcw} onClick={coldCall.onRetryCoaching}>Retry</TextButton>
            )}
          </div>
          {coldCall.coaching?.error ? (
            <div className="text-[13px] text-[var(--color-danger)]">{coldCall.coaching.error}</div>
          ) : coldCall.coaching?.text ? (
            <div className="flex flex-col gap-2">
              <Markdown>{coldCall.coaching.text}</Markdown>
              {!coldCall.coaching.streaming && coldCallHasPeopleToFollowUp(coldCall.coaching.text) && (
                <div className="flex flex-col gap-2">
                  {coldCall.booking?.error ? (
                    <div className="flex items-center gap-1.5">
                      <div className="text-[12px] text-[var(--color-danger)]">{coldCall.booking.error}</div>
                      <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>Retry</TextButton>
                    </div>
                  ) : coldCall.booking ? (
                    <div className="flex flex-col gap-2">
                      {coldCall.booking.streaming && !coldCall.booking.text ? (
                        <AgentStatus kind="writing" size="inline" caption />
                      ) : (
                        <Markdown>{coldCall.booking.text}</Markdown>
                      )}
                      {!coldCall.booking.streaming && (
                        <div className="flex items-center gap-1.5">
                          <TextButton icon={RotateCcw} onClick={coldCall.onBookMeetings}>Redo</TextButton>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Chip onClick={coldCall.onBookMeetings} variant="accent">
                      <Send size={13} /> Book meetings
                    </Chip>
                  )}
                </div>
              )}
            </div>
          ) : coldCall.coaching?.streaming ? (
            <AgentStatus kind="writing" size="hero" />
          ) : (
            // coaching === null means it was never STARTED (the call ended with nothing transcribed, so
            // generateColdCallCoaching returned early). Showing the spinner here — as this branch used to —
            // left a call that produced no audio spinning forever, with no error and no Retry, because
            // Retry only renders on an error. Offer the action instead of pretending work is in flight.
            <div className="flex items-center justify-between gap-2 py-1">
              <span className="text-[13px] text-[color:var(--color-ink-3)]">
                No coaching notes yet. Nothing was transcribed from this call.
              </span>
              {coldCall.onRetryCoaching && (
                <TextButton icon={RotateCcw} onClick={coldCall.onRetryCoaching}>
                  Generate
                </TextButton>
              )}
            </div>
          )}
        </section>
      )}

      {onGenerateFollowup && recapText && !editingRecap && (
        <section aria-live="polite">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
              <Mail size={12} /> Follow-up
            </div>
            {!followupDraft && (
              <div className="flex items-center gap-2">
                {winsToggle && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[color:var(--color-ink-2)]">
                    <input
                      type="checkbox"
                      checked={winsToggle.on}
                      onChange={(e) => winsToggle.onToggle(e.target.checked)}
                      className="no-drag size-3.5 cursor-pointer accent-[var(--color-accent)]"
                    />
                    Include our wins
                  </label>
                )}
                <Chip onClick={onGenerateFollowup} variant="accent">
                  <Mail size={13} /> Email recap
                </Chip>
              </div>
            )}
          </div>
          {followupDraft?.error ? (
            <div className="flex flex-col gap-2">
              <div className="text-[13px] text-[var(--color-danger)]">{followupDraft.error}</div>
              <div className="flex items-center gap-1.5">
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>Retry</TextButton>
              </div>
            </div>
          ) : followupDraft?.streaming && !followupText ? (
            <AgentStatus kind="writing" size="hero" />
          ) : followupDraft ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={followupText}
                onChange={(e) => {
                  const next = e.target.value
                  const nextIntent = outlookDraftIntent(outlookDraftMeeting, { subject: outlookDraftSubject, body: next })
                  if (outlookDraftLifecycle.select(nextIntent)) setOutlookDraftLocalError(null)
                  setFollowupEdited(true)
                  setFollowupText(next)
                }}
                rows={10}
                className="scroll-thin w-full resize-y rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3 text-[13px] leading-relaxed text-[color:var(--color-ink)] focus:outline-none"
              />
              <div className="flex items-center gap-1.5">
                <TextButton onClick={copyFollowup}>
                  {followupCopied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
                  {followupCopied ? 'Copied' : 'Copy'}
                </TextButton>
                <TextButton onClick={openFollowupInMail} disabled={!followupText}>
                  <Mail size={11} /> Open in Mail
                </TextButton>
                {outlook?.signedIn && outlook.canDraft ? (
                  <TextButton
                    onClick={() => void createOutlookDraft()}
                    disabled={!followupText || outlookDraftSession.phase === 'saving' || outlookDraftSession.phase === 'saved'}
                  >
                    <Mail size={11} /> {outlookDraftSession.phase === 'saved' ? 'Draft created' : outlookDraftSession.phase === 'saving' ? 'Creating draft…' : 'Create Outlook draft'}
                  </TextButton>
                ) : (
                  <TextButton
                    onClick={() =>
                      setOutlookDraftLocalError('Connect Outlook in Settings → Calendar. Métis will not send mail.')
                    }
                  >
                    <Mail size={11} /> Connect Outlook
                  </TextButton>
                )}
                <TextButton icon={RotateCcw} onClick={onGenerateFollowup}>
                  Regenerate
                </TextButton>
              </div>
              {mailError && <div className="text-[11px] text-[var(--color-danger)]">{mailError}</div>}
              {(outlookDraftLocalError || outlookDraftSession.error) && (
                <div className="text-[11px] text-[var(--color-danger)]">{outlookDraftLocalError || outlookDraftSession.error}</div>
              )}
              <div className="text-[11px] text-[color:var(--color-ink-3)]">
                Review before sending. Outlook creates a draft only. Nothing sends itself.
              </div>
            </div>
          ) : null}
        </section>
      )}

      <ReviewActionPanels {...props} />

      {lines.length === 0 ? null : !transcriptOpen ? (
        <button
          type="button"
          onClick={() => setTranscriptOpen(true)}
          className="no-drag focus-ring flex w-fit items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium text-[color:var(--color-ink-3)] hover:bg-white/[0.06] hover:text-[color:var(--color-ink-2)]"
        >
          <FileText size={12} />
          Show Transcript
          <span className="text-[color:var(--color-ink-3)] opacity-60">· {speechLines.length} lines</span>
          <ChevronDown size={12} className="-rotate-90" />
        </button>
      ) : (
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setTranscriptOpen(false)}
            className="no-drag focus-ring flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)] hover:text-[color:var(--color-ink-2)]"
          >
            <FileText size={12} /> Full transcript · {speechLines.length} lines <ChevronDown size={12} />
          </button>
          <TextButton onClick={copy}>
            {copied ? <Check size={11} className="text-[var(--color-success)]" /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </TextButton>
        </div>
        {copyError && (
          <div className="mb-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-2 py-1 text-[11px] text-[var(--color-danger)]">
            {copyError}
          </div>
        )}
        <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-3">
          {speechLines.length === 0 ? (
            <div className="text-[13px] text-[color:var(--color-ink-2)]">No transcript captured.</div>
          ) : (
            // No inner scroll trap for the recap body: the transcript list is virtualized only after
            // explicit disclosure, while the Summary remains owned by the parent Panel scroller.
            <VirtualList
              items={speechLines}
              getKey={(line, index) => `${line.t}:${line.speaker}:${index}`}
              estimateSize={(line) => Math.max(28, 18 + Math.ceil(line.text.length / 72) * 18)}
              className="scroll-thin h-[560px] max-h-[560px] overflow-y-auto"
              contentClassName="pr-1"
              ariaLabel="Full transcript"
              renderItem={({ item, style, measureRef }) => (
                <div key={`${item.t}:${item.speaker}:${item.text}`} ref={measureRef} style={style} className="pb-2">
                  <TranscriptRow line={item} />
                </div>
              )}
            />
          )}
        </div>
      </section>
      )}

      {/* Recent meetings list */}
      {recentMeetings.length > 0 && (
        <section className="mt-1">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
            <Clock size={11} /> Recent meetings
          </div>
          <div className="scroll-thin flex max-h-[220px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] p-1.5">
            {groupByDate(recentMeetings).map(([date, items]) => (
              <div key={date}>
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-ink-3)]">
                  {friendlyDate(date)}
                </div>
                {items.map((item) => (
                  <button
                    key={item.file}
                    type="button"
                    onClick={() => {
                      void (async () => {
                        if (await guardRecapEditNavigation()) onOpenPastMeeting?.(item.file)
                      })()
                    }}
                    className="no-drag focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06]"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--color-ink)]">
                      {item.title}
                    </span>
                    <span className="shrink-0 text-[11px] text-[color:var(--color-ink-3)]">
                      {meetingTime(item.date)}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[color:var(--color-ink-3)]">
                      {formatDurationMin(item.durationMin)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
