import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

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

func windowId(title: String) -> CGWindowID? {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for window in windows {
        guard (window[kCGWindowName as String] as? String) == title,
              let number = window[kCGWindowNumber as String] as? NSNumber else { continue }
        return CGWindowID(number.uint32Value)
    }
    return nil
}

func capture(title: String, output: String) -> Never {
    guard let id = windowId(title: title) else {
        fail("single-window row: target window not found: \(title)")
    }
    guard let image = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        id,
        [.boundsIgnoreFraming, .bestResolution]
    ) else {
        fail("BLOCKED_EXTERNAL: Screen Recording granted to the test host on the runner image.", code: 75)
    }
    let url = URL(fileURLWithPath: output)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        fail("single-window row: could not create PNG destination")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("single-window row: could not write PNG")
    }
    exit(0)
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
