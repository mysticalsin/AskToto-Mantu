import Foundation
import AVFoundation
import MetisKit
#if canImport(Speech)
import Speech
#endif
#if os(macOS)
import AppKit
import CoreGraphics
#elseif os(iOS)
import UIKit
#endif

/// The real OS implementation of MetisKit's `OnboardingPermissions` seam. Stateless (a value type, so it
/// is trivially `Sendable` under strict concurrency); it only reads/requests OS status and opens the
/// relevant privacy pane. All the flow logic and the restart nuance live in `OnboardingModel` — this file
/// is the thin platform edge that the package's tests replace with a mock.
struct PermissionsService: OnboardingPermissions {

    func status(_ kind: PermissionKind) async -> PermissionStatus {
        switch kind {
        case .microphone:
            return Self.map(AVCaptureDevice.authorizationStatus(for: .audio))
        case .speech:
            #if canImport(Speech)
            return Self.mapSpeech(SFSpeechRecognizer.authorizationStatus())
            #else
            return .unknown
            #endif
        case .screenRecording:
            #if os(macOS)
            // Preflight can't distinguish "denied" from "not yet asked" — both read false. Treat false as
            // not-determined so the row offers an action rather than a dead-end; a real request disambiguates.
            return CGPreflightScreenCaptureAccess() ? .granted : .notDetermined
            #else
            return .unknown
            #endif
        }
    }

    func request(_ kind: PermissionKind) async -> PermissionStatus {
        switch kind {
        case .microphone:
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            return granted ? .granted : .denied
        case .speech:
            #if canImport(Speech)
            return await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: Self.mapSpeech(status))
                }
            }
            #else
            return .unknown
            #endif
        case .screenRecording:
            #if os(macOS)
            // Prompts on first ask; returns the standing decision afterwards. The grant only reaches this
            // process on the NEXT launch, which is why OnboardingModel surfaces "restart" once it flips.
            return CGRequestScreenCaptureAccess() ? .granted : .notDetermined
            #else
            return .unknown
            #endif
        }
    }

    func openSystemSettings(_ kind: PermissionKind) {
        #if os(macOS)
        let anchor: String
        switch kind {
        case .microphone: anchor = "Privacy_Microphone"
        case .speech: anchor = "Privacy_SpeechRecognition"
        case .screenRecording: anchor = "Privacy_ScreenCapture"
        }
        guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") else { return }
        Task { @MainActor in NSWorkspace.shared.open(url) }
        #elseif os(iOS)
        Task { @MainActor in
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        #endif
    }

    // MARK: Mapping

    private static func map(_ status: AVAuthorizationStatus) -> PermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }

    #if canImport(Speech)
    private static func mapSpeech(_ status: SFSpeechRecognizerAuthorizationStatus) -> PermissionStatus {
        switch status {
        case .authorized: return .granted
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown
        }
    }
    #endif
}

/// Relaunch helper for the Screen Recording "restart" state (macOS applies a fresh grant only to the next
/// launch). No-op on iOS, which has no screen row.
enum AppRelaunch {
    @MainActor static func relaunch() {
        #if os(macOS)
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, _ in
            Task { @MainActor in NSApp.terminate(nil) }
        }
        #endif
    }
}
