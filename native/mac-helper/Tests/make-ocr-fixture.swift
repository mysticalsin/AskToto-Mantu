// Renders two large text lines onto a white PNG so the helper's OCR output has known words and order.
// Usage: swift make-ocr-fixture.swift <out.png> [english|french]
import AppKit

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write("usage: make-ocr-fixture.swift <out.png> [english|french]\n".data(using: .utf8)!)
    exit(1)
}
let width = 900
let height = 500
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
    samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
), let context = NSGraphicsContext(bitmapImageRep: rep) else {
    FileHandle.standardError.write("fixture: could not create bitmap\n".data(using: .utf8)!)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 72, weight: .bold),
    .foregroundColor: NSColor.black
]
let mode = CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : "english"
let top = mode == "french" ? "BONJOUR EQUIPE" : "TOP LINE"
let bottom = mode == "french" ? "MERCI METIS" : "BOTTOM LINE"
// AppKit's bitmap origin is bottom-left, so a large y is visually near the top.
NSAttributedString(string: top, attributes: attributes).draw(at: NSPoint(x: 60, y: 380))
NSAttributedString(string: bottom, attributes: attributes).draw(at: NSPoint(x: 60, y: 40))
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("fixture: could not encode png\n".data(using: .utf8)!)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
