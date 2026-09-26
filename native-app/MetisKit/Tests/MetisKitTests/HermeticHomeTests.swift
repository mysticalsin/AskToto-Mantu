import XCTest
import Foundation

/// W0-HERMETIC (M2-0190) — canary proving `swift test` for this package runs under
/// scripts/hermetic/run-swift-tests.sh (never bare `swift test`), which sets both `HOME` and
/// `CFFIXED_USER_HOME` — Foundation's `NSHomeDirectory()`/`homeDirectoryForCurrentUser` resolve from
/// `getpwuid()` on Darwin, not from `$HOME` alone, so `CFFIXED_USER_HOME` is the override that actually
/// redirects them.
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
    // Isolation itself is proven by isolation-canary.yml's metiskit-swift-test job, which seeds a
    // honeypot in the runner's real home and fails the job if this suite ever touches it — a check
    // against the fresh sandbox dir here would pass trivially (empty by construction) and prove nothing.
}
