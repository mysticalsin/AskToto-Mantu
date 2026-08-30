import Foundation

// App Intents — the Siri / Spotlight / Shortcuts / Action-button surface. Research (WWDC 2024/2025, App
// Intents docs, 3-0 verified) established these register IN-PROCESS via an AppShortcutsProvider in the
// app's `init` — no App Store distribution and no separate .appex required for the intents themselves.
// These structs live in the shared package; the per-platform app target owns the AppShortcutsProvider and
// the actual recording/meeting store the `perform()` bodies drive (wired via the AppActions protocol so
// the package stays free of app-target types).

/// The app target conforms a controller to this and installs it at launch, so intents can drive real
/// recording/summarize actions without the package importing app internals.
///
/// Defined OUTSIDE the `canImport(AppIntents)` gate below: `MeetingController` conforms to it
/// unconditionally, so gating the protocol would break compilation anywhere AppIntents is absent
/// (older SDKs, and Linux `swift test` / CI). The protocol itself has no AppIntents dependency; only the
/// concrete intent structs do.
public protocol MeetingActions: Sendable {
    func startRecording() async throws
    func stopRecording() async throws
    func currentSummary() async throws -> String
    func lastThingSaid() async throws -> String
}

public enum MeetingActionsRegistry {
    nonisolated(unsafe) public static var shared: MeetingActions?
}

#if canImport(AppIntents)
import AppIntents

private func actions() throws -> MeetingActions {
    guard let a = MeetingActionsRegistry.shared else { throw MetisIntentError.notReady }
    return a
}

public enum MetisIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notReady
    public var localizedStringResource: LocalizedStringResource {
        switch self { case .notReady: return "Métis isn't ready yet. Open the app once, then try again." }
    }
}

/// A single toggle intent for recording (Apple's guidance: prefer one toggle over separate start/stop).
@available(macOS 26.0, iOS 26.0, *)
public struct ToggleRecordingIntent: AppIntent {
    public static let title: LocalizedStringResource = "Toggle Meeting Recording"
    public static let description = IntentDescription("Start or stop recording the current meeting in Métis.")
    public static var openAppWhenRun: Bool { false }

    @Parameter(title: "Recording", default: true)
    public var record: Bool

    public init() {}
    public init(record: Bool) { self.record = record }

    @MainActor
    public func perform() async throws -> some IntentResult & ProvidesDialog {
        if record { try await actions().startRecording(); return .result(dialog: "Recording started.") }
        try await actions().stopRecording(); return .result(dialog: "Recording stopped.")
    }
}

/// "Summarize my meeting" — returns the on-device Foundation Model summary as spoken/− displayed dialog.
@available(macOS 26.0, iOS 26.0, *)
public struct SummarizeMeetingIntent: AppIntent {
    public static let title: LocalizedStringResource = "Summarize Meeting"
    public static let description = IntentDescription("Summarize the current meeting using on-device Apple Intelligence.")
    public init() {}
    @MainActor
    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let summary = try await actions().currentSummary()
        return .result(dialog: IntentDialog(stringLiteral: summary))
    }
}

/// "What did they just say" — reads back the last remote-speaker line.
@available(macOS 26.0, iOS 26.0, *)
public struct LastThingSaidIntent: AppIntent {
    public static let title: LocalizedStringResource = "What Did They Just Say"
    public static let description = IntentDescription("Repeat the last thing the other person said.")
    public init() {}
    @MainActor
    public func perform() async throws -> some IntentResult & ProvidesDialog {
        let line = try await actions().lastThingSaid()
        return .result(dialog: IntentDialog(stringLiteral: line))
    }
}

/// The shortcuts phrase set. The app target references this type from its AppShortcutsProvider; Siri picks
/// up these phrases with no user configuration once registered.
@available(macOS 26.0, iOS 26.0, *)
public struct MetisShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ToggleRecordingIntent(), phrases: [
            "Start recording in \(.applicationName)",
            "Record my meeting with \(.applicationName)"
        ], shortTitle: "Toggle Recording", systemImageName: "record.circle")
        AppShortcut(intent: SummarizeMeetingIntent(), phrases: [
            "Summarize my meeting with \(.applicationName)",
            "\(.applicationName) summary"
        ], shortTitle: "Summarize", systemImageName: "text.append")
        AppShortcut(intent: LastThingSaidIntent(), phrases: [
            "What did they just say in \(.applicationName)"
        ], shortTitle: "Last Said", systemImageName: "quote.bubble")
    }
}
#endif
