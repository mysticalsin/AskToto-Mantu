import AppKit
import Dispatch
import Foundation
import ScreenCaptureKit

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

func runWindow(title: String, text: String, x: Double, y: Double, level: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let window = NSWindow(
        contentRect: NSRect(x: x, y: y, width: 720, height: 240),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    window.title = title
    if level == "floating" {
        window.level = .floating
    }
    let label = NSTextField(labelWithString: text)
    label.font = NSFont.systemFont(ofSize: 58, weight: .bold)
    label.textColor = .black
    label.backgroundColor = .white
    label.alignment = .center
    label.frame = NSRect(x: 20, y: 70, width: 680, height: 90)
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 240))
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.white.cgColor
    view.addSubview(label)
    window.contentView = view
    window.orderFrontRegardless()
    print("ready")
    fflush(stdout)
    app.run()
    exit(0)
}

@available(macOS 14.0, *)
func captureWithScreenCaptureKit(title: String, output: String) async -> Never {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { ($0.title ?? "") == title }) else {
            fail("single-window row: target window not found: \(title)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l\(window.windowID)", output]
        try process.run()
        process.waitUntilExit()
        if process.terminationStatus != 0 {
            fail("BLOCKED_EXTERNAL: Screen Recording granted to the test host on the runner image.", code: 75)
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: output)
        if (attributes[.size] as? NSNumber)?.intValue ?? 0 <= 0 {
            fail("single-window row: screenshot output was empty")
        }
    } catch {
        fail("BLOCKED_EXTERNAL: Screen Recording granted to the test host on the runner image.", code: 75)
    }
    exit(0)
}

func capture(title: String, output: String) -> Never {
    guard #available(macOS 14.0, *) else {
        fail("single-window row: ScreenCaptureKit screenshot capture requires macOS 14 or newer")
    }
    Task {
        await captureWithScreenCaptureKit(title: title, output: output)
    }
    dispatchMain()
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: single-window-ocr-row.swift window|capture ...")
}
switch args[1] {
case "window":
    guard args.count == 7 else {
        fail("usage: single-window-ocr-row.swift window <title> <text> <x> <y> <normal|floating>")
    }
    runWindow(
        title: args[2],
        text: args[3],
        x: Double(args[4]) ?? 80,
        y: Double(args[5]) ?? 420,
        level: args[6]
    )
case "capture":
    guard args.count == 4 else {
        fail("usage: single-window-ocr-row.swift capture <title> <out.png>")
    }
    capture(title: args[2], output: args[3])
default:
    fail("usage: single-window-ocr-row.swift window|capture ...")
}
