import Foundation
import MetisKit

/// Wires platform audio capture into the controller. This is the ONE deeply platform-conditional piece
/// (native-app/README.md): macOS gets ScreenCaptureKit loopback (THEM) + AVAudioEngine mic (ME); iOS /
/// iPadOS get mic only — there is no loopback API on iOS, which is why iOS is the in-person / one-room
/// companion, not a two-sided copilot.
///
/// Roadmap step 2 fills in the real capture and feeds `SpeechTranscriber` lines into
/// `controller.append(TranscriptLine(...))`. For now this installs no-op start/stop hooks so recording
/// STATE and the App Intents "Toggle Recording" work end-to-end (verified in MeetingControllerTests) while
/// the capture backend lands — no frames are captured yet.
enum AudioCapture {
    @MainActor static func wire(into controller: MeetingController) {
        #if os(macOS)
        controller.audioStart = {
            // TODO (roadmap 2, macOS): SCStream system-audio loopback (THEM) + AVAudioEngine mic (ME) →
            // SpeechTranscriber → controller.append(TranscriptLine(speaker:...)). Requires the
            // com.apple.security.device.audio-input entitlement + Screen Recording permission.
        }
        #else
        controller.audioStart = {
            // TODO (roadmap 2, iOS/iPadOS): AVAudioEngine mic only (in-person mode) → SpeechTranscriber →
            // controller.append(...). Requires NSMicrophoneUsageDescription; no loopback (Apple-forbidden).
        }
        #endif
        controller.audioStop = {
            // TODO (roadmap 2): tear down the capture graph + finalize the transcript.
        }
    }
}
