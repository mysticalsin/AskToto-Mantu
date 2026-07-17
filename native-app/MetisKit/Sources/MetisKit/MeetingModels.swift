import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// Meeting domain models shared across every platform. The @Generable types are the typed shapes the
// on-device Foundation Model fills directly (guided generation) — no JSON parsing, no prompt-format
// drift. The plain models are the persisted transcript/meeting records (SwiftData wraps these in the
// app target).

public struct TranscriptLine: Identifiable, Codable, Sendable, Hashable {
    public enum Speaker: String, Codable, Sendable { case me, them, unknown }
    public let id: UUID
    public var speaker: Speaker
    /// Voice-identified name when known (enrolled profile or "Speaker N") — mirrors the Electron app's
    /// additive `name` field so transcripts port across both products.
    public var name: String?
    public var text: String
    public var at: Date
    public init(id: UUID = UUID(), speaker: Speaker, name: String? = nil, text: String, at: Date) {
        self.id = id; self.speaker = speaker; self.name = name; self.text = text; self.at = at
    }
}

public struct Meeting: Identifiable, Codable, Sendable {
    public let id: UUID
    public var title: String
    public var startedAt: Date
    public var endedAt: Date?
    public var lines: [TranscriptLine]
    public init(id: UUID = UUID(), title: String, startedAt: Date, endedAt: Date? = nil, lines: [TranscriptLine] = []) {
        self.id = id; self.title = title; self.startedAt = startedAt; self.endedAt = endedAt; self.lines = lines
    }
    /// The last `maxChars` of the transcript — the bounded context handed to the model (matches the
    /// Electron app's 6000-char suggest window).
    public func transcriptTail(maxChars: Int = 6000) -> String {
        let joined = lines.map { line in
            let who = line.name ?? (line.speaker == .me ? "You" : line.speaker == .them ? "Them" : "Speaker")
            return "\(who): \(line.text)"
        }.joined(separator: "\n")
        return String(joined.suffix(maxChars))
    }
}

#if canImport(FoundationModels)
/// Typed meeting summary the model generates directly via guided generation.
@available(macOS 26.0, iOS 26.0, *)
@Generable
public struct MeetingSummaryResult {
    @Guide(description: "A single sentence capturing the meeting's outcome.")
    public var headline: String
    @Guide(description: "Concrete decisions made, each as a short phrase.")
    public var decisions: [String]
    @Guide(description: "Action items as 'owner: task' where an owner is named.")
    public var actionItems: [String]
    @Guide(description: "Open questions or risks raised but not resolved.")
    public var openQuestions: [String]
}

/// A speaking suggestion plus a self-assessed confidence — lets the UI show low-confidence prompts
/// differently and feeds the on-device fact-check gate.
@available(macOS 26.0, iOS 26.0, *)
@Generable
public struct SuggestionResult {
    @Guide(description: "One natural sentence the user could say next. No preamble.")
    public var line: String
    @Guide(description: "Confidence from 0 to 1 that this is well-grounded in the transcript.")
    public var confidence: Double
}
#endif
