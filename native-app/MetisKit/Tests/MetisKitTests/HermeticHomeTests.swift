import XCTest
import Foundation
@testable import MetisKit

/// W0-HERMETIC (M2-0190) — MetisKit has no on-disk persistence today (see PersistenceCodableTests.swift's
/// own note: the SwiftData container needs an app host, so it's exercised on-device, not here), so
/// `swift test` isn't currently exposed to the real-OneDrive hazard M2-0001 closed for vitest. This is
/// the same defense-in-depth M2-0190 gives every non-vitest runner: a canary that fails loudly the
/// moment `swift test` ever runs again without the sandbox — before any future disk-touching code in
/// this package could reach a real profile unnoticed.
///
/// `HOME` and `CFFIXED_USER_HOME` here are both set by scripts/hermetic/run-swift-tests.sh, which every
/// CI/agent invocation of `swift test` for this package must go through — never bare `swift test`, or
/// both are unset and this canary fails loudly. On Darwin, Foundation's `NSHomeDirectory()`/
/// `FileManager.default.homeDirectoryForCurrentUser` resolve from `getpwuid()`, NOT from `$HOME` alone,
/// for an ordinary process — `CFFIXED_USER_HOME` is the override CoreFoundation's home-directory
/// resolution actually honors. No Foundation Model or `@testable` seam has to change for this to hold.
final class HermeticHomeTests: XCTestCase {
    func testHomeIsThePerRunSandboxNotTheRealProfile() throws {
        guard let sandboxHome = ProcessInfo.processInfo.environment["METIS_TEST_HOME"] else {
            XCTFail("METIS_TEST_HOME is unset — run swift test via scripts/hermetic/run-swift-tests.sh, never directly")
            return
        }
        XCTAssertTrue(
            (sandboxHome as NSString).lastPathComponent.hasPrefix("metis-test-home-"),
            "sandbox home \(sandboxHome) doesn't look like scripts/hermetic's mktemp'd directory"
        )
        XCTAssertEqual(NSHomeDirectory(), sandboxHome, "NSHomeDirectory() must resolve to the sandbox, not the real user profile")
        XCTAssertEqual(
            FileManager.default.homeDirectoryForCurrentUser.path, sandboxHome,
            "FileManager's home must agree with NSHomeDirectory() — both resolve via CFFIXED_USER_HOME, never $HOME alone"
        )
    }
    // A "the fresh sandbox has no real Library/CloudStorage" check always passes trivially — a
    // brand-new mktemp'd directory is empty by construction, proving nothing about isolation. The real
    // proof is isolation-canary.yml's metiskit-swift-test job, which seeds a honeypot in the RUNNER'S
    // REAL home and fails the job if this suite ever touches it.
}
