import Foundation
import Observation

public enum MeetingOperationError: Error, LocalizedError, Equatable, Sendable {
    case operationInProgress, savePending, saveUnavailable, saveFailed, stopFailed, startFailed, staleAction

    public var errorDescription: String? {
        switch self {
        case .operationInProgress: return "A meeting operation is already in progress. Please wait."
        case .savePending: return "Your transcript is retained. Choose Retry save before starting another meeting."
        case .saveUnavailable: return "Your transcript is retained. Open the meeting window, then choose Retry save."
        case .saveFailed: return "Your transcript is retained. Saving failed; choose Retry save."
        case .stopFailed: return "Your transcript is retained. Capture could not be stopped; try Stop again."
        case .startFailed: return "Recording could not start. Your transcript is retained; try Record again."
        case .staleAction: return "The meeting changed before this action finished. Please try again."
        }
    }
}

/// The platform-neutral heart of the native app: owns the live `Meeting`, drives the on-device
/// intelligence, and satisfies the App Intents seam (`MeetingActions`). The thin per-platform SwiftUI app
/// owns ONLY audio capture + windowing and injects a recording start/stop hook; everything else lives here
/// so it is shared across macOS / iPadOS / iOS AND unit-tested in the package (no SwiftUI, no audio, no
/// platform-conditional types). This is the "App/ Store + controller" box in native-app/README.md, pulled
/// into MetisKit so roadmap step 1's logic is verified by `swift test` rather than only at app-build time.
/// `@Observable` so the SwiftUI app can bind to `meeting`/`isRecording` directly without a wrapper.
@Observable
@MainActor
public final class MeetingController: MeetingActions {
    public private(set) var meeting: Meeting
    public private(set) var isRecording = false
    public private(set) var isTransitioning = false
    public private(set) var operationError: MeetingOperationError?
    public private(set) var actionRevision = UUID()
    private var acceptedSummary: MeetingSummaryText?
    private var pendingSave: (meeting: Meeting, summary: MeetingSummaryText?)?
    private var persistence: (@MainActor (Meeting, MeetingSummaryText?) async throws -> Void)?
    private let intelligence: MeetingIntelligence

    public var needsSaveRetry: Bool { pendingSave != nil }
    public var isPersistenceReady: Bool { persistence != nil }

    /// Bind once to the application's existing container; retries cannot silently switch stores.
    public func bindPersistence(_ save: @escaping @MainActor (Meeting, MeetingSummaryText?) async throws -> Void) {
        guard persistence == nil else { return }
        persistence = save
    }

    /// Injected by the app target: begin/end real audio capture (ScreenCaptureKit + mic on macOS, mic on
    /// iOS). Left nil in tests and before the app wires them — recording then just flips the state so the
    /// intents/UI stay driveable without an audio backend.
    public var audioStart: (@Sendable () async throws -> Void)?
    public var audioStop: (@Sendable () async throws -> Void)?

    /// The task draining a live transcript stream into the meeting; cancelled on stop or replace.
    private(set) var transcriptionTask: Task<Void, Never>?
    private var transcriptionRevision = UUID()

    public init(
        intelligence: MeetingIntelligence = makeMeetingIntelligence(),
        meeting: Meeting = Meeting(title: "Meeting", startedAt: Date())
    ) {
        self.intelligence = intelligence
        self.meeting = meeting
    }

    /// True on an Apple-Intelligence device where the on-device Foundation Model is ready; false when the
    /// controller is running on the heuristic fallback. Lets the UI badge "on-device AI" vs "basic mode".
    public var intelligenceAvailable: Bool {
        if case .available = intelligence.availability { return true }
        return false
    }

    // MARK: Transcript
    @discardableResult
    public func append(_ line: TranscriptLine) -> Bool {
        guard !isTransitioning, pendingSave == nil else { return false }
        if meeting.endedAt != nil, meeting.lines.isEmpty { newMeeting() }
        meeting.lines.append(line)
        return true
    }

    @discardableResult
    public func reset(title: String = "Meeting") -> Bool {
        guard !isRecording, !isTransitioning, pendingSave == nil else { return false }
        newMeeting(title: title)
        return true
    }

    private func newMeeting(title: String = "Meeting") {
        endTranscription()
        actionRevision = UUID()
        acceptedSummary = nil
        operationError = nil
        meeting = Meeting(title: title, startedAt: Date())
    }

    /// Start draining a live transcript stream — each recognized line is appended on the main actor.
    /// Cancels any prior stream. The app calls this from its audio start with the real SpeechTranscriber's
    /// output (App/SpeechTranscription.swift); tests pass a fake `AsyncStream`. Platform-neutral: no audio
    /// or Speech types cross into MetisKit, so this stays testable + shared across all three platforms.
    public func beginTranscription(_ stream: AsyncStream<TranscriptLine>) {
        guard pendingSave == nil else { return }
        endTranscription()
        let revision = transcriptionRevision
        let meetingID = meeting.id
        transcriptionTask = Task { [weak self] in
            for await line in stream {
                guard !Task.isCancelled, let self,
                      self.transcriptionRevision == revision, self.meeting.id == meetingID,
                      self.pendingSave == nil
                else { break }
                // Keep collecting during audio shutdown, until stop acknowledges and closes this stream.
                self.meeting.lines.append(line)
            }
        }
    }
    /// Stop draining the live transcript (idempotent).
    public func endTranscription() {
        transcriptionRevision = UUID()
        transcriptionTask?.cancel()
        transcriptionTask = nil
    }

    // MARK: Intelligence (bounded transcript-tail window, same strategy as the Electron app)
    public func acceptsAction(_ revision: UUID) -> Bool {
        revision == actionRevision && !isTransitioning && pendingSave == nil
    }

    private func currentAction<Result: Sendable>(
        _ action: @MainActor (String) async throws -> Result
    ) async throws -> Result {
        let revision = actionRevision
        guard acceptsAction(revision) else { throw MeetingOperationError.staleAction }
        do {
            let result = try await action(meeting.transcriptTail())
            guard acceptsAction(revision) else { throw MeetingOperationError.staleAction }
            return result
        } catch {
            guard acceptsAction(revision) else { throw MeetingOperationError.staleAction }
            throw error
        }
    }

    public func suggestion() async throws -> String {
        try await currentAction { try await self.intelligence.suggest(transcriptTail: $0) }
    }
    public func summaryText() async throws -> MeetingSummaryText {
        let revision = actionRevision
        let result = try await currentAction { try await self.intelligence.summarize(transcriptTail: $0) }
        guard acceptsAction(revision) else { throw MeetingOperationError.staleAction }
        acceptedSummary = result
        return result
    }
    public func nextSteps() async throws -> [String] {
        try await currentAction { try await self.intelligence.nextSteps(transcriptTail: $0) }
    }

    // MARK: MeetingActions — the App Intents / Siri / Shortcuts seam (MeetingIntents.swift)
    public func startRecording() async throws {
        guard !isTransitioning else { throw MeetingOperationError.operationInProgress }
        guard pendingSave == nil else { throw MeetingOperationError.savePending }
        if isRecording { return } // idempotent: a second "start" from Siri must not restart the clock
        isTransitioning = true
        actionRevision = UUID()
        operationError = nil
        defer { isTransitioning = false }
        if meeting.endedAt != nil, meeting.lines.isEmpty { newMeeting() }
        do {
            try await audioStart?()
            isRecording = true
            meeting.startedAt = Date()
        } catch {
            operationError = .startFailed
            throw MeetingOperationError.startFailed
        }
    }
    public func stopRecording() async throws {
        guard !isTransitioning else { throw MeetingOperationError.operationInProgress }
        guard isRecording || pendingSave != nil || !meeting.lines.isEmpty else { return }
        isTransitioning = true
        actionRevision = UUID()
        operationError = nil
        defer { isTransitioning = false }

        if pendingSave == nil {
            if isRecording {
                do { try await audioStop?() }
                catch {
                    operationError = .stopFailed
                    throw MeetingOperationError.stopFailed
                }
            }
            endTranscription()
            isRecording = false
            meeting.endedAt = Date()
            guard !meeting.lines.isEmpty else { return }
            pendingSave = (meeting, acceptedSummary)
        }

        guard let pendingSave else { return }
        guard let persistence else {
            operationError = .saveUnavailable
            throw MeetingOperationError.saveUnavailable
        }
        do { try await persistence(pendingSave.meeting, pendingSave.summary) }
        catch {
            operationError = .saveFailed
            throw MeetingOperationError.saveFailed
        }
        self.pendingSave = nil
        newMeeting()
    }
    public func currentSummary() async throws -> String {
        let revision = actionRevision
        let s = try await summaryText()
        guard acceptsAction(revision) else { throw MeetingOperationError.staleAction }
        return s.headline.isEmpty ? "Nothing to summarize yet." : s.headline
    }
    public func lastThingSaid() async throws -> String {
        meeting.lines.last(where: { $0.speaker == .them })?.text ?? "I haven't heard the other person yet."
    }
}
