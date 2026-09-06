import XCTest
@testable import MetisKit

/// A deterministic in-memory `OnboardingPermissions` so the whole first-run flow is testable without any
/// OS prompt. `@unchecked Sendable` with an `NSLock` because the protocol is `Sendable` and the model may
/// touch it across suspension points; the lock keeps the mutable maps race-free under strict concurrency.
///
/// All mutable state is read/written through the synchronous `withLock` helper. Swift 6 strict concurrency
/// forbids calling `NSLock.lock()/unlock()` *directly* from an `async` function, so the `async` protocol
/// requirements funnel through this non-async helper (where the raw lock calls are legal) instead.
private final class MockPermissions: OnboardingPermissions, @unchecked Sendable {
    private let lock = NSLock()
    private var statuses: [PermissionKind: PermissionStatus]
    private var requestResults: [PermissionKind: PermissionStatus]
    private var opened: [PermissionKind] = []

    init(statuses: [PermissionKind: PermissionStatus] = [:], requestResults: [PermissionKind: PermissionStatus] = [:]) {
        self.statuses = statuses
        self.requestResults = requestResults
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }

    func set(_ kind: PermissionKind, _ status: PermissionStatus) {
        withLock { statuses[kind] = status }
    }
    func openedSettings() -> [PermissionKind] {
        withLock { opened }
    }
    func status(_ kind: PermissionKind) async -> PermissionStatus {
        withLock { statuses[kind] ?? .notDetermined }
    }
    func request(_ kind: PermissionKind) async -> PermissionStatus {
        withLock {
            let result = requestResults[kind] ?? .granted
            statuses[kind] = result
            return result
        }
    }
    func openSystemSettings(_ kind: PermissionKind) {
        withLock { opened.append(kind) }
    }
}

@MainActor
final class OnboardingModelTests: XCTestCase {
    private func makeModel(
        _ perms: MockPermissions,
        includeScreenRow: Bool = true,
        intelligence: Bool = false,
        transcription: Bool = false,
        onFinish: (@MainActor @Sendable (MeetingMode, Bool) -> Void)? = nil
    ) -> OnboardingModel {
        OnboardingModel(
            permissions: perms,
            includeScreenRow: includeScreenRow,
            probeIntelligenceAvailable: { intelligence },
            probeTranscriptionReady: { transcription },
            onFinish: onFinish
        )
    }

    private func advance(_ m: OnboardingModel, to scene: OnboardingScene) {
        var guardCount = 0
        while m.scene != scene && guardCount < 10 { m.advance(); guardCount += 1 }
    }

    // MARK: Navigation

    func testStartsOnHeroWithFourGuidedActs() async {
        let m = makeModel(MockPermissions())
        XCTAssertEqual(m.scene, .hero)
        XCTAssertEqual(OnboardingScene.guided, [.story, .reveal, .setup, .personalize])
    }

    func testAdvanceWalksEveryActThenStops() async {
        let m = makeModel(MockPermissions())
        m.advance(); XCTAssertEqual(m.scene, .story)
        m.advance(); XCTAssertEqual(m.scene, .reveal)
        m.advance(); XCTAssertEqual(m.scene, .setup)
        m.advance(); XCTAssertEqual(m.scene, .personalize)
        m.advance(); XCTAssertEqual(m.scene, .personalize, "advancing past the last act stays put")
    }

    func testSkipJumpsToPersonalizeButStillGatesOnConsent() async {
        let m = makeModel(MockPermissions())
        m.skip()
        XCTAssertEqual(m.scene, .personalize)
        XCTAssertFalse(m.canFinish, "skip must not bypass the consent gate")
        m.finish()
        XCTAssertFalse(m.finished, "finish without consent is a no-op")
    }

    // MARK: Problem-story staging

    func testStoryRevealsOneLineAtATime() async {
        let m = makeModel(MockPermissions())
        XCTAssertEqual(m.revealedStoryLines, 1)
        XCTAssertFalse(m.storyComplete)
        for _ in 0..<m.storyLines.count { m.revealNextStoryLine() }
        XCTAssertEqual(m.revealedStoryLines, m.storyLines.count)
        XCTAssertTrue(m.storyComplete)
        m.revealNextStoryLine() // never overshoots
        XCTAssertEqual(m.revealedStoryLines, m.storyLines.count)
    }

    // MARK: Setup — the honest magic moment

    func testSetupChecksReportRealVerdicts() async {
        let perms = MockPermissions(statuses: [.microphone: .granted, .screenRecording: .granted])
        let m = makeModel(perms, intelligence: true, transcription: true)
        advance(m, to: .setup)
        await m.runSetupChecks()

        XCTAssertEqual(m.currentRow("intelligence")?.state, .ready)
        XCTAssertEqual(m.currentRow("asr")?.state, .ready)
        XCTAssertEqual(m.currentRow("brain")?.state, .ready)
        XCTAssertEqual(m.currentRow("mic")?.state, .ready)
        XCTAssertEqual(m.currentRow("screen")?.state, .ready)
        XCTAssertTrue(m.allReady)
        XCTAssertFalse(m.needsPermissions)
    }

    func testSetupWithoutIntelligenceOrModelsStaysHonestButReady() async {
        let perms = MockPermissions(statuses: [.microphone: .granted, .screenRecording: .granted])
        let m = makeModel(perms, intelligence: false, transcription: false)
        advance(m, to: .setup)
        await m.runSetupChecks()
        // Non-actionable gaps are skipped, not "needed" — the "everything ready" close stays truthful.
        XCTAssertEqual(m.currentRow("intelligence")?.state, .skipped)
        XCTAssertEqual(m.currentRow("asr")?.state, .skipped)
        XCTAssertTrue(m.allReady)
    }

    func testDeniedMicrophoneBlocksAndNeedsAttention() async {
        let perms = MockPermissions(statuses: [.microphone: .denied, .screenRecording: .granted])
        let m = makeModel(perms, intelligence: true, transcription: true)
        advance(m, to: .setup)
        await m.runSetupChecks()
        XCTAssertEqual(m.currentRow("mic")?.state, .blocked)
        XCTAssertTrue(m.needsPermissions)
        XCTAssertFalse(m.allReady)
    }

    func testNotDeterminedMicIsRequestedAndReflected() async {
        let perms = MockPermissions(statuses: [.microphone: .notDetermined, .screenRecording: .granted],
                                    requestResults: [.microphone: .granted])
        let m = makeModel(perms, intelligence: true, transcription: true)
        advance(m, to: .setup)
        await m.runSetupChecks() // requests mic (not-determined) then refreshes
        XCTAssertEqual(m.currentRow("mic")?.state, .ready)
    }

    func testScreenGrantMidSessionShowsRestart() async {
        let perms = MockPermissions(statuses: [.microphone: .granted, .screenRecording: .denied])
        let m = makeModel(perms, intelligence: true, transcription: true)
        advance(m, to: .setup)
        await m.runSetupChecks()
        XCTAssertEqual(m.currentRow("screen")?.state, .blocked)
        // User flips Screen Recording on in System Settings; this process must relaunch to use it.
        perms.set(.screenRecording, .granted)
        await m.refreshPermissions()
        XCTAssertEqual(m.currentRow("screen")?.state, .restart)
    }

    func testMicSettingsDeepLinkInvoked() async {
        let perms = MockPermissions()
        let m = makeModel(perms)
        m.openSettings(.microphone)
        XCTAssertEqual(perms.openedSettings(), [.microphone])
    }

    func testScreenRowOmittedWhenNotIncluded() async {
        let perms = MockPermissions(statuses: [.microphone: .granted])
        let m = makeModel(perms, includeScreenRow: false, intelligence: true, transcription: true)
        advance(m, to: .setup)
        await m.runSetupChecks()
        XCTAssertNil(m.currentRow("screen"))
        XCTAssertTrue(m.allReady)
    }

    // MARK: Personalize + consent + finish

    func testConsentGateAndFinishCallback() async {
        let perms = MockPermissions()
        var captured: (MeetingMode, Bool)?
        let m = makeModel(perms, onFinish: { mode, consent in captured = (mode, consent) })
        m.skip()
        m.mode = .sales
        XCTAssertFalse(m.canFinish)
        m.finish()
        XCTAssertNil(captured, "no consent -> no finish")
        m.consent = true
        XCTAssertTrue(m.canFinish)
        m.finish()
        XCTAssertTrue(m.finished)
        XCTAssertEqual(captured?.0, .sales)
        XCTAssertEqual(captured?.1, true)
        // Idempotent: a second finish must not fire the callback again.
        captured = nil
        m.finish()
        XCTAssertNil(captured)
    }

    // MARK: Pure mappers

    func testMicRowStateMapping() async {
        XCTAssertEqual(micRowState(for: .granted).state, .ready)
        XCTAssertEqual(micRowState(for: .denied).state, .blocked)
        XCTAssertEqual(micRowState(for: .restricted).state, .blocked)
        XCTAssertEqual(micRowState(for: .notDetermined).state, .action)
        XCTAssertEqual(micRowState(for: .unknown).state, .action)
    }

    func testScreenRowStateMapping() async {
        XCTAssertEqual(screenRowState(granted: true, justGranted: true).state, .restart)
        XCTAssertEqual(screenRowState(granted: true, justGranted: false).state, .ready)
        XCTAssertEqual(screenRowState(granted: false, justGranted: false, denied: true).state, .blocked)
        XCTAssertEqual(screenRowState(granted: false, justGranted: false).state, .action)
    }

    func testMeetingModeCardsCoverThreeChoices() async {
        XCTAssertEqual(MeetingMode.allCases, [.general, .sales, .recruiting])
        XCTAssertFalse(MeetingMode.sales.blurb.isEmpty)
    }
}
