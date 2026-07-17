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
import AppKit
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

// MARK: - entry point

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: metis-mac-helper <watch-frontmost|ocr> [path|-]")
}
switch arguments[1] {
case "watch-frontmost":
    watchFrontmost()
case "ocr":
    runOcr(inputPath: arguments.count >= 3 ? arguments[2] : "-")
default:
    fail("unknown command: \(arguments[1])")
}
