import Foundation
import Observation

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
    private let intelligence: MeetingIntelligence

    /// Injected by the app target: begin/end real audio capture (ScreenCaptureKit + mic on macOS, mic on
    /// iOS). Left nil in tests and before the app wires them — recording then just flips the state so the
    /// intents/UI stay driveable without an audio backend.
    public var audioStart: (@Sendable () async throws -> Void)?
    public var audioStop: (@Sendable () async throws -> Void)?

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
    public func append(_ line: TranscriptLine) { meeting.lines.append(line) }
    public func reset(title: String = "Meeting") { meeting = Meeting(title: title, startedAt: Date()) }

    // MARK: Intelligence (bounded transcript-tail window, same strategy as the Electron app)
    public func suggestion() async throws -> String {
        try await intelligence.suggest(transcriptTail: meeting.transcriptTail())
    }
    public func summaryText() async throws -> MeetingSummaryText {
        try await intelligence.summarize(transcriptTail: meeting.transcriptTail())
    }
    public func nextSteps() async throws -> [String] {
        try await intelligence.nextSteps(transcriptTail: meeting.transcriptTail())
    }

    // MARK: MeetingActions — the App Intents / Siri / Shortcuts seam (MeetingIntents.swift)
    public func startRecording() async throws {
        if isRecording { return } // idempotent: a second "start" from Siri must not restart the clock
        try await audioStart?()
        isRecording = true
        meeting.startedAt = Date()
    }
    public func stopRecording() async throws {
        if !isRecording { return }
        try await audioStop?()
        isRecording = false
        meeting.endedAt = Date()
    }
    public func currentSummary() async throws -> String {
        let s = try await summaryText()
        return s.headline.isEmpty ? "Nothing to summarize yet." : s.headline
    }
    public func lastThingSaid() async throws -> String {
        meeting.lines.last(where: { $0.speaker == .them })?.text ?? "I haven't heard the other person yet."
    }
}
