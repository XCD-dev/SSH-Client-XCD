import AppKit
import Foundation

func color(_ hex: String) -> NSColor {
    let value = UInt32(hex, radix: 16)!
    return NSColor(
        red: CGFloat((value >> 16) & 0xff) / 255,
        green: CGFloat((value >> 8) & 0xff) / 255,
        blue: CGFloat(value & 0xff) / 255,
        alpha: 1
    )
}

func bitmap(width: Int, height: Int, draw: () -> Void) -> NSBitmapImageRep {
    let image = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!
    let context = NSGraphicsContext(bitmapImageRep: image)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
    draw()
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return image
}

func pngData(_ image: NSBitmapImageRep) -> Data {
    image.representation(using: .png, properties: [:])!
}

func write(_ image: NSBitmapImageRep, to path: String) throws {
    try pngData(image).write(to: URL(fileURLWithPath: path))
}

func drawIcon(size: Int) -> NSBitmapImageRep {
    let scale = CGFloat(size) / 512
    return bitmap(width: size, height: size) {
        color("151c24").setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
            xRadius: 112 * scale,
            yRadius: 112 * scale
        ).fill()

        color("67d7c9").setStroke()
        let chevron = NSBezierPath()
        chevron.move(to: NSPoint(x: 164 * scale, y: 333 * scale))
        chevron.line(to: NSPoint(x: 274 * scale, y: 256 * scale))
        chevron.line(to: NSPoint(x: 164 * scale, y: 179 * scale))
        chevron.lineWidth = 32 * scale
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        chevron.stroke()

        let cursor = NSBezierPath()
        cursor.move(to: NSPoint(x: 304 * scale, y: 179 * scale))
        cursor.line(to: NSPoint(x: 376 * scale, y: 179 * scale))
        cursor.lineWidth = 32 * scale
        cursor.lineCapStyle = .round
        cursor.stroke()
    }
}

func drawLogo() -> NSBitmapImageRep {
    return bitmap(width: 1080, height: 260) {
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: 1080, height: 260).fill()

        color("151c24").setFill()
        NSBezierPath(roundedRect: NSRect(x: 28, y: 30, width: 200, height: 200), xRadius: 46, yRadius: 46).fill()

        color("67d7c9").setStroke()
        let chevron = NSBezierPath()
        chevron.move(to: NSPoint(x: 88, y: 160))
        chevron.line(to: NSPoint(x: 138, y: 130))
        chevron.line(to: NSPoint(x: 88, y: 100))
        chevron.lineWidth = 15
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        chevron.stroke()
        let cursor = NSBezierPath()
        cursor.move(to: NSPoint(x: 157, y: 100))
        cursor.line(to: NSPoint(x: 194, y: 100))
        cursor.lineWidth = 15
        cursor.lineCapStyle = .round
        cursor.stroke()

        let wordmark: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 126, weight: .bold),
            .foregroundColor: color("18212b")
        ]
        ("XCD" as NSString).draw(at: NSPoint(x: 286, y: 92), withAttributes: wordmark)
        let subtitle: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 28, weight: .semibold),
            .foregroundColor: color("586773"),
            .kern: 7
        ]
        ("SSH CLIENT" as NSString).draw(at: NSPoint(x: 292, y: 48), withAttributes: subtitle)
    }
}

func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var littleEndian = value.littleEndian
    withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
}

let iconMac = drawIcon(size: 1024)
let iconLinux = drawIcon(size: 512)
let iconWindows = drawIcon(size: 256)
try write(iconMac, to: "build/icon-mac.png")
try write(iconLinux, to: "build/icon.png")
try write(drawLogo(), to: "build/logo.png")

let iconPng = pngData(iconWindows)
var ico = Data([0, 0, 1, 0, 1, 0, 0, 0, 0, 0])
appendLittleEndian(UInt16(1), to: &ico)
appendLittleEndian(UInt16(32), to: &ico)
appendLittleEndian(UInt32(iconPng.count), to: &ico)
appendLittleEndian(UInt32(22), to: &ico)
ico.append(iconPng)
try ico.write(to: URL(fileURLWithPath: "build/icon.ico"))
