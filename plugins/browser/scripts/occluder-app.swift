// A stand-in for "the person's app" in scripts/live-parking.mjs: one ordinary
// titled (or borderless), opaque window, activated, in a real NSApplication run
// loop, so it occludes like real apps do and Accessibility can resize it
// (DeepSea Window Helper's make-room).
//
//   swiftc -O -o <bin> scripts/occluder-app.swift
//   <bin> <seconds> <coverage> [borderless] [screen]
//     coverage: screen | zoomed | left:F | inset:N
//     screen:   main (default) | widest | an index into NSScreen.screens
//
// Prints the window's frame (top-left coordinates) once it is up, and quits
// after <seconds>.
import AppKit

let args = CommandLine.arguments
let seconds = Double(args.count > 1 ? args[1] : "30") ?? 30
let coverage = args.count > 2 ? args[2] : "zoomed"
// A titled window leaves a sliver along its right edge unoccluded (2–8 pt showing, as real apps do), so
// parking needs no trimming under ordinary apps; a borderless window occludes it: the make-room case.
let borderless = args.count > 3 && args[3] == "borderless"
let choice = args.count > 4 ? args[4] : "main"

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = choice == "widest" ? NSScreen.screens.max(by: { $0.frame.width < $1.frame.width })!
    : Int(choice).flatMap { NSScreen.screens.indices.contains($0) ? NSScreen.screens[$0] : nil } ?? NSScreen.main!
var frame = coverage == "screen" ? screen.frame : screen.visibleFrame
if coverage.hasPrefix("left:"), let f = Double(coverage.dropFirst(5)) { frame.size.width *= f }
if coverage.hasPrefix("inset:"), let n = Double(coverage.dropFirst(6)) {
    frame = NSRect(x: frame.minX + n, y: frame.minY + n, width: frame.width - n, height: frame.height - n)
}
final class KeyWindow: NSWindow { override var canBecomeKey: Bool { true }; override var canBecomeMain: Bool { true } }
let window = KeyWindow(contentRect: frame, styleMask: borderless ? [.borderless, .resizable] : [.titled, .resizable, .closable, .miniaturizable], backing: .buffered, defer: false)
window.setFrame(frame, display: true)
window.title = "DeepSea occluder"
window.isOpaque = true
window.backgroundColor = NSColor(srgbRed: 0.15, green: 0.15, blue: 0.18, alpha: 1)
window.isReleasedWhenClosed = false
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
let top = (NSScreen.screens.first?.frame.height ?? 0) - window.frame.maxY
print("\(Int(window.frame.minX)),\(Int(top)),\(Int(window.frame.width)),\(Int(window.frame.height))")
fflush(stdout)
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { app.terminate(nil) }
app.run()
