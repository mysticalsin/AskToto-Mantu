import Foundation
import Observation

/// Onboarding — the platform-neutral state machine behind the native five-act first-run experience
/// (Hero -> Problem story -> Reveal -> "Your setup" live checks -> Personalize + consent), the Métis
/// translation of the Vibe Island onboarding anatomy captured in docs/ONBOARDING-EXPERIENCE.md and
/// already shipped in the Electron app (src/renderer/src/components/OnboardingExperience.tsx).
///
/// The logic lives here in MetisKit — not the SwiftUI app target — for the same reason MeetingController
/// does: it is verified by `swift test` on a Mac/CI without a running UI, and shared across platforms.
/// The app target injects the one platform-conditional piece (real OS permission calls) through
/// `OnboardingPermissions`; every scene transition, row-state verdict, and the consent gate are pure and
/// unit-tested with a mock. The honesty rule from the spec is enforced here: a row only ever reads
/// "ready" when the injected probe/permission actually said so — the magic moment is never faked.

// MARK: - Personalization

/// How the user will primarily use Métis — the Scene 5 "How will you use Métis?" cards. Mirrors the three
/// cards the Electron onboarding offers; a persisted preference the app can later route prompts on.
public enum MeetingMode: String, Codable, CaseIterable, Sendable, Identifiable {
    case general, sales, recruiting
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .general: return "General"
        case .sales: return "Sales"
        case .recruiting: return "Recruiting"
        }
    }
    public var blurb: String {
        switch self {
        case .general: return "Every meeting, every topic"
        case .sales: return "Deals, objections, next steps"
        case .recruiting: return "You interview: STAR probes, challenges"
        }
    }
}

// MARK: - Scenes

/// The five acts, in order. `hero` is the welcome beat, not a guided step — the progress dots only track
/// the acts the user is actively inside (reveal onward), matching the Electron `GUIDED_SCENES` behavior.
public enum OnboardingScene: String, CaseIterable, Sendable {
    case hero, story, reveal, setup, personalize

    /// The acts shown by the progress indicator (hero excluded — see above).
    public static let guided: [OnboardingScene] = [.story, .reveal, .setup, .personalize]

    var next: OnboardingScene {
        switch self {
        case .hero: return .story
        case .story: return .reveal
        case .reveal: return .setup
        case .setup: return .personalize
        case .personalize: return .personalize
        }
    }
}

// MARK: - Permissions contract

/// The OS permissions the setup scene checks. Screen recording is macOS-only (system-audio loopback / the
/// two-sided copilot); iOS is in-person mic-only, so the app omits the screen row there.
public enum PermissionKind: String, Sendable, CaseIterable {
    case microphone, speech, screenRecording
}

/// A normalized permission status, decoupled from AVFoundation / Speech / ScreenCaptureKit so this core
/// (and its tests) never import an Apple UI framework.
public enum PermissionStatus: String, Sendable, Equatable {
    case notDetermined, granted, denied, restricted, unknown
}

/// The seam the app target implements with real OS calls (App/Permissions/PermissionsService.swift). The
/// model only ever talks to this protocol, so tests drive the whole flow with a deterministic mock.
public protocol OnboardingPermissions: Sendable {
    func status(_ kind: PermissionKind) async -> PermissionStatus
    /// Trigger the OS consent prompt (no-op / returns current status when the OS won't re-prompt).
    func request(_ kind: PermissionKind) async -> PermissionStatus
    /// Deep-link to the relevant System Settings privacy pane (for an already-denied permission).
    func openSystemSettings(_ kind: PermissionKind)
}

// MARK: - Setup rows

/// The lifecycle of a single "Your setup" row. Ported 1:1 from the Electron `SetupRowState` so the two
/// products behave identically:
/// - `restart`: the permission is granted, but this running process's capture handle never saw it
///   (macOS applies a fresh Screen Recording grant only to the NEXT launch) — needs a relaunch, not a prompt.
/// - `blocked`: the OS holds an explicit Deny, which no prompt can undo — only the privacy pane can.
/// - `skipped`: not user-actionable and not required (e.g. on-device model absent -> heuristic fallback).
public enum SetupRowState: String, Sendable, Equatable {
    case checking, ready, action, blocked, restart, skipped
}

public struct SetupRow: Identifiable, Sendable, Equatable {
    public let key: String
    public var label: String
    public var systemImage: String
    public var state: SetupRowState
    public var detail: String
    public var id: String { key }
    public init(key: String, label: String, systemImage: String, state: SetupRowState, detail: String = "") {
        self.key = key; self.label = label; self.systemImage = systemImage; self.state = state; self.detail = detail
    }
}

// MARK: - Pure row-state mappers (directly unit-tested)

/// The microphone row for an OS permission status. `denied`/`restricted` MUST map to `blocked`, not
/// `action`: once the user has said no, the OS never re-prompts, so the only way back is the privacy pane
/// — exactly the distinction the Electron `micRowStatus` draws.
public func micRowState(for status: PermissionStatus) -> (state: SetupRowState, detail: String) {
    switch status {
    case .granted: return (.ready, "granted")
    case .denied, .restricted: return (.blocked, "permission denied")
    case .notDetermined, .unknown: return (.action, "needs permission")
    }
}

/// The screen-recording row. `justGranted` is the false->true flip observed mid-scene (the user toggled it
/// on in System Settings just now): the grant is real but this process must relaunch before ScreenCaptureKit
/// can use it, so the row shows `restart` rather than `ready`.
public func screenRowState(granted: Bool, justGranted: Bool, denied: Bool = false) -> (state: SetupRowState, detail: String) {
    if justGranted { return (.restart, "granted") }
    if granted { return (.ready, "granted") }
    if denied { return (.blocked, "permission denied") }
    return (.action, "needs permission")
}

// MARK: - Model

/// Drives the five-act flow. `@Observable` so the SwiftUI scenes bind directly (same pattern as
/// MeetingController); `@MainActor` because it mutates observable UI state and calls permission APIs.
@Observable
@MainActor
public final class OnboardingModel {
    public private(set) var scene: OnboardingScene = .hero
    public private(set) var rows: [SetupRow] = []
    public var mode: MeetingMode = .general
    /// Recording consent — a REQUIRED gate before "Start" (restored in the Electron flow after CMO-QA #1).
    public var consent: Bool = false
    public private(set) var finished = false

    /// Problem-story staging: lines are revealed one at a time (the emotional core — see the spec), then
    /// the user advances to the reveal. Tracked here so both the timing view and the tests can drive it.
    public let storyLines: [String]
    public private(set) var revealedStoryLines: Int = 1
    public var storyComplete: Bool { revealedStoryLines >= storyLines.count }

    @ObservationIgnored private let permissions: OnboardingPermissions
    @ObservationIgnored private let includeScreenRow: Bool
    @ObservationIgnored private let probeIntelligenceAvailable: @Sendable () -> Bool
    @ObservationIgnored private let probeTranscriptionReady: @Sendable () async -> Bool
    @ObservationIgnored private let onFinish: (@MainActor @Sendable (MeetingMode, Bool) -> Void)?
    /// Tracks the last-seen screen-recording grant so a false->true flip can be told apart from
    /// "already granted on mount" — only the former needs a relaunch (see `screenRowState`).
    @ObservationIgnored private var screenPreviouslyGranted: Bool?

    public init(
        permissions: OnboardingPermissions,
        includeScreenRow: Bool = true,
        storyLines: [String] = OnboardingModel.defaultStoryLines,
        probeIntelligenceAvailable: @escaping @Sendable () -> Bool = { false },
        probeTranscriptionReady: @escaping @Sendable () async -> Bool = { false },
        onFinish: (@MainActor @Sendable (MeetingMode, Bool) -> Void)? = nil
    ) {
        self.permissions = permissions
        self.includeScreenRow = includeScreenRow
        self.storyLines = storyLines
        self.probeIntelligenceAvailable = probeIntelligenceAvailable
        self.probeTranscriptionReady = probeTranscriptionReady
        self.onFinish = onFinish
    }

    /// The Métis translation of Vibe Island's staged problem story (spec Scene 2).
    public static let defaultStoryLines: [String] = [
        "You're in the meeting.",
        "The question lands on you.",
        "You know that you know it.",
        "…and the moment passes."
    ]

    // MARK: Navigation

    public func advance() {
        scene = scene.next
    }

    /// The setup scene calls `runSetupChecks()` from its `.task` on appear (not here) so navigation stays
    /// synchronous and side-effect-free — which also keeps every transition trivially unit-testable.

    /// "Skip the tour" — jump straight to personalize. It still lands on the consent gate: skipping the
    /// narrative must never skip consent (the Electron CMO-QA #1 fix).
    public func skip() {
        scene = .personalize
    }

    public func revealNextStoryLine() {
        guard revealedStoryLines < storyLines.count else { return }
        revealedStoryLines += 1
    }

    // MARK: Setup scene — the live "magic moment"

    /// Run the REAL checks the moment the setup scene mounts. Every verdict comes from an injected probe
    /// or permission call; nothing is hardcoded to "ready".
    public func runSetupChecks() async {
        var base: [SetupRow] = [
            SetupRow(key: "intelligence", label: "Apple Intelligence", systemImage: "sparkles", state: .checking),
            SetupRow(key: "asr", label: "On-device transcription", systemImage: "waveform", state: .checking),
            SetupRow(key: "brain", label: "Private meeting brain", systemImage: "lock.doc", state: .checking),
            SetupRow(key: "mic", label: "Microphone", systemImage: "mic", state: .checking)
        ]
        if includeScreenRow {
            base.append(SetupRow(key: "screen", label: "Screen context", systemImage: "rectangle.on.rectangle", state: .checking))
        }
        rows = base
        screenPreviouslyGranted = nil

        // Apple Intelligence: not user-actionable. Ready when the on-device model is present, otherwise a
        // non-blocking "basic mode" note (skipped keeps the "everything ready" close honest).
        if probeIntelligenceAvailable() {
            setRow("intelligence", .ready, "on-device model ready")
        } else {
            setRow("intelligence", .skipped, "basic mode — works without it")
        }

        let asrReady = await probeTranscriptionReady()
        setRow("asr", asrReady ? .ready : .skipped, asrReady ? "ready" : "downloads on first use")

        // The meeting brain is local by construction on this platform — nothing to configure, nothing uploaded.
        setRow("brain", .ready, "stays on this Mac")

        let micStatus = await permissions.status(.microphone)
        let mic = micRowState(for: micStatus)
        setRow("mic", mic.state, mic.detail)

        if includeScreenRow {
            let screenStatus = await permissions.status(.screenRecording)
            let granted = screenStatus == .granted
            screenPreviouslyGranted = granted
            let screen = screenRowState(granted: granted, justGranted: false, denied: screenStatus == .denied || screenStatus == .restricted)
            setRow("screen", screen.state, screen.detail)
        }

        // Proactively trigger the OS consent prompts so the pane registers Métis (macOS won't list an app
        // in Screen Recording until it has probed once). Fire-and-forget: the poll below reflects outcomes.
        if micStatus == .notDetermined { _ = await permissions.request(.microphone) ; await refreshPermissions() }
    }

    /// Re-read permission status while the setup scene stays mounted, so a grant flipped in System Settings
    /// (possibly in a split view next to the app) is reflected without the user clicking anything.
    public func refreshPermissions() async {
        guard scene == .setup, !rows.isEmpty else { return }
        let micStatus = await permissions.status(.microphone)
        let mic = micRowState(for: micStatus)
        setRow("mic", mic.state, mic.detail)

        if includeScreenRow {
            let screenStatus = await permissions.status(.screenRecording)
            let granted = screenStatus == .granted
            let justGranted = screenPreviouslyGranted == false && granted
            // Once we've decided a relaunch is needed this session, keep saying so until the app restarts.
            let stillRestart = currentRow("screen")?.state == .restart
            screenPreviouslyGranted = granted
            if justGranted || stillRestart {
                setRow("screen", .restart, "granted")
            } else {
                let screen = screenRowState(granted: granted, justGranted: false, denied: screenStatus == .denied || screenStatus == .restricted)
                setRow("screen", screen.state, screen.detail)
            }
        }
    }

    /// Inline "Allow Microphone" action. On an explicit prior Deny the OS won't re-prompt — the row is
    /// already `blocked` and the view offers the settings deep-link instead.
    public func requestMicrophone() async {
        let status = await permissions.request(.microphone)
        let mic = micRowState(for: status)
        setRow("mic", mic.state, mic.detail)
    }

    public func openSettings(_ kind: PermissionKind) {
        permissions.openSystemSettings(kind)
    }

    // MARK: Derived

    /// Every row is either genuinely ready or a non-blocking skip — the "Everything's ready" close.
    public var allReady: Bool {
        !rows.isEmpty && rows.allSatisfy { $0.state == .ready || $0.state == .skipped }
    }

    /// A permission still needs attention (drives whether Continue is primary, never whether it's allowed).
    public var needsPermissions: Bool {
        rows.contains {
            ($0.key == "mic" || $0.key == "screen") && ($0.state == .action || $0.state == .blocked || $0.state == .restart)
        }
    }

    /// Consent is the only hard gate on finishing — permissions can be granted later.
    public var canFinish: Bool { consent }

    public func finish() {
        guard consent, !finished else { return }
        finished = true
        onFinish?(mode, true)
    }

    // MARK: Row helpers

    private func setRow(_ key: String, _ state: SetupRowState, _ detail: String) {
        guard let i = rows.firstIndex(where: { $0.key == key }) else { return }
        rows[i].state = state
        rows[i].detail = detail
    }

    public func currentRow(_ key: String) -> SetupRow? {
        rows.first(where: { $0.key == key })
    }
}
