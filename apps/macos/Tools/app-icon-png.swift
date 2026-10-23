// app-icon-png — the icon macOS itself shows for a bundle (Finder/Dock
// rendition: on macOS 26 the Liquid Glass squircle, correctly rounded, with
// the system's own shading), written as a PNG at the requested pixel size.
//
//   xcrun swiftc -O -o build/app-icon-png Tools/app-icon-png.swift -framework Cocoa
//   build/app-icon-png <Some.app> <out.png> [--size 512]
import Cocoa

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2 else { fputs("usage: app-icon-png <bundle.app> <out.png> [--size N]\n", stderr); exit(2) }
let size = args.firstIndex(of: "--size").flatMap { Int(args[$0 + 1]) } ?? 512
let icon = NSWorkspace.shared.icon(forFile: args[0])
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { fputs("png encode failed\n", stderr); exit(1) }
try! png.write(to: URL(fileURLWithPath: args[1]))
