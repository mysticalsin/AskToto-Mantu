// metis-mac-helper — dependency-free macOS sidecar for Métis (compiled by scripts/build-mac-helper.mjs,
// shipped via electron-builder's mac extraResources; mirrors the llama-server sidecar pattern).
//
// Two subcommands, both designed to plug into EXISTING main-process seams without new protocols:
//
//   watch-frontmost   Long-running. Prints one TSV line per app activation — the SAME
//                     `windowId \t pid \t title` shape foreground-watcher.ts already parses from the
//                     Windows PowerShell watcher (windowId = bundle id on mac; app-level granularity —
//                     intra-app tab/window switches are covered by screen-preprocess's 6s content
//                     re-check, so AX permissions are deliberately NOT required here).
//
//   ocr [path|-]      One-shot. Reads an image (file path, or stdin with '-'), runs Vision's
//                     VNRecognizeTextRequest (accurate mode; GA API for years, deterministic), prints
//                     one JSON object {width, height, lines:[{text, confidence, box:[x,y,w,h]}]} and
//                     exits. box is Vision-normalized (origin bottom-left, 0..1) — the TS consumer
//                     sorts top-to-bottom. Spawn-per-call: OCR is throttled upstream (≥2.5s between
//                     describes), so a ~100ms process start is cheaper than keeping a server alive.
//
//   transcribe <wav> [locale]  One-shot. Runs Apple's Speech framework (SFSpeechRecognizer) fully
//                     on-device over a 16kHz mono WAV file and prints the plain-text transcription to
//                     stdout. The optional locale (BCP-47, e.g. pt-BR) pins the recognizer's language
//                     — the app's spoken-language setting — falling back to the system locale. No Apple
//                     Intelligence toggle required — SFSpeechRecognizer has shipped on-device dictation
//                     since macOS 13. Mirrors the batch-per-window contract the Parakeet ASR engine
//                     already uses (see main/apple-speech.ts): one call in, one text result out.
import AppKit
import Speech
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

// MARK: - watch-frontmost

func emitFrontmost(_ app: NSRunningApplication?) {
    guard let app else { return }
    // Tabs are the field separator — strip them from free-text fields (same rule as the PS watcher).
    let bundle = (app.bundleIdentifier ?? "pid-\(app.processIdentifier)")
        .replacingOccurrences(of: "\t", with: " ")
    let name = (app.localizedName ?? "").replacingOccurrences(of: "\t", with: " ")
    print("\(bundle)\t\(app.processIdentifier)\t\(name)")
    fflush(stdout)
}

func watchFrontmost() -> Never {
    // Emit the current app immediately so the consumer has initial state without waiting for a switch.
    emitFrontmost(NSWorkspace.shared.frontmostApplication)
    NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification,
        object: nil,
        queue: .main
    ) { note in
        emitFrontmost(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
    }
    RunLoop.main.run()
    exit(0)
}

// MARK: - ocr

struct OcrLine: Codable {
    let text: String
    let confidence: Double
    let box: [Double]
}

struct OcrResult: Codable {
    let width: Int
    let height: Int
    let lines: [OcrLine]
}

func runOcr(inputPath: String) -> Never {
    let data: Data
    if inputPath == "-" {
        data = FileHandle.standardInput.readDataToEndOfFile()
    } else {
        guard let fileData = FileManager.default.contents(atPath: inputPath) else {
            fail("ocr: could not read \(inputPath)")
        }
        data = fileData
    }
    guard !data.isEmpty,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fail("ocr: input is not a decodable image")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("ocr: \(error.localizedDescription)")
    }

    var lines: [OcrLine] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        lines.append(
            OcrLine(
                text: candidate.string,
                confidence: Double(candidate.confidence),
                box: [box.origin.x, box.origin.y, box.size.width, box.size.height]
            )
        )
    }

    let result = OcrResult(width: image.width, height: image.height, lines: lines)
    do {
        let encoded = try JSONEncoder().encode(result)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    } catch {
        fail("ocr: could not encode result: \(error.localizedDescription)")
    }
    exit(0)
}

// MARK: - transcribe

/// One-shot, fully on-device speech-to-text over a WAV file via SFSpeechRecognizer. Never sends audio
/// off-device: requiresOnDeviceRecognition is forced true, so this either transcribes locally or fails —
/// it never silently falls back to Apple's cloud recognizer. Any failure (missing file, no on-device
/// model for this locale, authorization denied, timeout) prints to stderr and exits non-zero; the TS
/// caller (apple-speech.ts) treats that as "no result" and the app falls back to another ASR engine.
func runTranscribe(path: String, localeIdentifier: String?) -> Never {
    guard FileManager.default.fileExists(atPath: path) else {
        fail("transcribe: file not found at \(path)")
    }

    // Locale precedence: the caller's explicit identifier (the app's spoken-language setting — a system
    // locale says nothing about what language a meeting is held in) → the user's current locale → en-US
    // (always available). SFSpeechRecognizer returns nil for a locale it has no model for, so each step
    // falls through instead of failing outright.
    let requested = localeIdentifier.flatMap { SFSpeechRecognizer(locale: Locale(identifier: $0)) }
    guard let recognizer = requested ?? SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
        fail("transcribe: no speech recognizer available for this Mac")
    }
    guard recognizer.supportsOnDeviceRecognition else {
        fail("transcribe: on-device recognition is not available for this language on this Mac")
    }

    // SFSpeechRecognizer.requestAuthorization's completion handler queue is not documented, so this
    // waits by pumping the run loop rather than blocking on a semaphore — safe whether the callback
    // lands on the main queue or a background one (a semaphore would risk a main-thread deadlock if a
    // future OS ever dispatches it back onto the main queue), and still bounded to ~15s so a stuck
    // authorization prompt can never hang the caller forever.
    var authStatus: SFSpeechRecognizerAuthorizationStatus?
    SFSpeechRecognizer.requestAuthorization { status in authStatus = status }
    let authDeadline = Date().addingTimeInterval(15)
    while authStatus == nil && Date() < authDeadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    switch authStatus {
    case .authorized:
        break
    case .denied, .restricted:
        fail("transcribe: speech recognition access denied")
    default:
        fail("transcribe: speech recognition authorization timed out")
    }

    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false

    var finalText: String?
    var recognitionError: Error?
    var finished = false
    let task = recognizer.recognitionTask(with: request) { result, error in
        if let error {
            recognitionError = error
            finished = true
            return
        }
        if let result, result.isFinal {
            finalText = result.bestTranscription.formattedString
            finished = true
        }
    }

    let resultDeadline = Date().addingTimeInterval(15)
    while !finished && Date() < resultDeadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    if !finished {
        task.cancel()
        fail("transcribe: recognition timed out")
    }
    if let recognitionError {
        fail("transcribe: \(recognitionError.localizedDescription)")
    }
    print(finalText ?? "")
    fflush(stdout)
    exit(0)
}

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: metis-mac-helper <watch-frontmost|ocr|transcribe> [path|-]")
}
switch arguments[1] {
case "watch-frontmost":
    watchFrontmost()
case "ocr":
    runOcr(inputPath: arguments.count >= 3 ? arguments[2] : "-")
case "transcribe":
    guard arguments.count >= 3 else {
        fail("usage: metis-mac-helper transcribe <wav-path> [locale]")
    }
    runTranscribe(path: arguments[2], localeIdentifier: arguments.count >= 4 ? arguments[3] : nil)
default:
    fail("unknown command: \(arguments[1])")
}
