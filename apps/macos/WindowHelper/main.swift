// DeepSea Window Helper: window layout and placement for the browser plugin
// (plugins/browser, placement.mjs), as a small background app, so macOS's
// Accessibility grant belongs to this one machine-wide bundle
// (io.github.taliesinb.deepsea) rather than to whichever DeepSea server runs
// a script. Every variant on the Mac uses the same helper and the same grant.
//
// Launched per command through LaunchServices, which makes it its own
// responsible process for macOS's privacy checks:
//
//   open -W -g -n -a "DeepSea Window Helper.app" --stdout OUT --stderr ERR --args <command> [options]
//
// Every command prints one JSON object on stdout and exits 0; a failure is
// {"ok": false, "error": "..."} (exit 1). Coordinates are global screen points
// with the origin at the top-left of the primary screen (the CoreGraphics and
// Accessibility convention, and the page's screenX/screenY).
//
// Commands
//   request-access
//       Ask macOS for the Accessibility grant (its own prompt; run it once
//       without -g so the prompt comes forward).
//   layout
//       Screens (frame and visible frame), the frontmost app, every on-screen
//       window of the normal layer (CG window number, pid, owner, bundle id,
//       bounds, alpha), and whether the helper has Accessibility. Needs no
//       permission; window titles are not read.
//   make-room --width N [--min-width M] [--exclude-bundle ID]...
//       Make an N-point strip at the right edge of the screen under the
//       frontmost app's windows free of them: a window reaching into the strip
//       is narrowed (its left edge kept) to stop short of it, never below
//       --min-width (default 480). Reports each window's frame before and
//       after, so the caller can restore it.
//   restore --pid P --frame x,y,w,h --expect x,y,w,h
//       Put a window of P back to --frame, but only if it is still at --expect
//       (nobody moved or resized it since).
//   move --pid P --match x,y,w,h --to x,y [--size w,h]
//       Move (and optionally resize) the window of P whose frame matches
//       --match within 2 points.

import AppKit
import ApplicationServices

// MARK: output

func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    var out = object
    if out["ok"] == nil { out["ok"] = exitCode == 0 }
    let data = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}
func fail(_ message: String) -> Never { emit(["ok": false, "error": message], exitCode: 1) }

func rectJSON(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.size.width), "height": Double(r.size.height)]
}
func parseRect(_ s: String) -> CGRect? {
    let p = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    return p.count == 4 ? CGRect(x: p[0], y: p[1], width: p[2], height: p[3]) : nil
}
func parsePoint(_ s: String) -> CGPoint? {
    let p = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    return p.count == 2 ? CGPoint(x: p[0], y: p[1]) : nil
}

// MARK: arguments

var args = Array(CommandLine.arguments.dropFirst())
// LaunchServices may add a -psn_… argument.
args.removeAll { $0.hasPrefix("-psn_") }
guard let command = args.first else { fail("no command (request-access | layout | make-room | restore | move)") }
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func options(_ name: String) -> [String] {
    var out: [String] = []
    for (i, a) in args.enumerated() where a == "--\(name)" && i + 1 < args.count { out.append(args[i + 1]) }
    return out
}

// MARK: screens (top-left coordinates)

/// Height of the primary screen: flips AppKit's bottom-left frames into the top-left space.
let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
func flipped(_ r: NSRect) -> CGRect { CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height) }
struct Screen { let frame: CGRect; let visible: CGRect }
let screens = NSScreen.screens.map { Screen(frame: flipped($0.frame), visible: flipped($0.visibleFrame)) }
func screen(containing r: CGRect) -> Screen? {
    screens.max { a, b in a.frame.intersection(r).area < b.frame.intersection(r).area }
}
extension CGRect { var area: CGFloat { isNull ? 0 : width * height } }

// MARK: Accessibility

func axValue<T>(_ element: AXUIElement, _ attribute: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? T
}
func axFrame(_ window: AXUIElement) -> CGRect? {
    guard let pos: AXValue = axValue(window, kAXPositionAttribute), let size: AXValue = axValue(window, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pos, .cgPoint, &p); AXValueGetValue(size, .cgSize, &s)
    return CGRect(origin: p, size: s)
}
@discardableResult func axSetPosition(_ window: AXUIElement, _ p: CGPoint) -> AXError {
    var point = p
    return AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &point)!)
}
@discardableResult func axSetSize(_ window: AXUIElement, _ s: CGSize) -> AXError {
    var size = s
    return AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
}
func axWindows(pid: pid_t) -> [AXUIElement] {
    (axValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as [AXUIElement]?) ?? []
}
func requireTrust() {
    if !AXIsProcessTrusted() {
        fail("DeepSea Window Helper is not allowed to use Accessibility: System Settings ▸ Privacy & Security ▸ Accessibility ▸ enable \"DeepSea Window Helper\"")
    }
}
func close(_ a: CGRect, _ b: CGRect, _ tolerance: CGFloat = 2) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}

// MARK: commands

switch command {
case "layout":
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var windows: [[String: Any]] = []
    for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let pid = w[kCGWindowOwnerPID as String] as? pid_t else { continue }
        let bounds = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        windows.append([
            "id": w[kCGWindowNumber as String] as? Int ?? 0,
            "pid": Int(pid),
            "owner": w[kCGWindowOwnerName as String] as? String ?? "",
            "bundleId": NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "",
            "bounds": rectJSON(bounds),
            "alpha": w[kCGWindowAlpha as String] as? Double ?? 1,
        ])
    }
    let front = NSWorkspace.shared.frontmostApplication
    emit([
        "accessibility": AXIsProcessTrusted(),
        "screens": screens.map { ["frame": rectJSON($0.frame), "visible": rectJSON($0.visible)] },
        "frontmost": ["pid": Int(front?.processIdentifier ?? 0), "bundleId": front?.bundleIdentifier ?? "", "name": front?.localizedName ?? ""],
        "windows": windows,
    ])

case "request-access":
    // macOS's own prompt, which leads to the right settings pane.
    let trusted = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    emit(["accessibility": trusted])

case "make-room":
    requireTrust()
    guard let width = option("width").flatMap(Double.init), width > 0 else { fail("make-room needs --width N") }
    let minWidth = option("min-width").flatMap(Double.init) ?? 480
    let excluded = Set(options("exclude-bundle"))
    guard let front = NSWorkspace.shared.frontmostApplication else { fail("no frontmost app") }
    let base: [String: Any] = ["pid": Int(front.processIdentifier), "bundleId": front.bundleIdentifier ?? "", "name": front.localizedName ?? ""]
    if excluded.contains(front.bundleIdentifier ?? "") { emit(base.merging(["changed": false, "reason": "excluded", "trims": []]) { $1 }) }
    // Every window of the frontmost app (they are all above STP's), not only the focused one: an app may
    // have no key window (borderless windows never become key; a panel may be in front).
    let app = AXUIElementCreateApplication(front.processIdentifier)
    var candidates = axWindows(pid: front.processIdentifier)
    if let focused: AXUIElement = axValue(app, kAXFocusedWindowAttribute), !candidates.contains(where: { CFEqual($0, focused) }) { candidates.insert(focused, at: 0) }
    if candidates.isEmpty { emit(base.merging(["changed": false, "reason": "the frontmost app has no windows", "trims": []]) { $1 }) }
    let frames = candidates.compactMap { w in axFrame(w).map { (w, $0) } }
    guard let scr = frames.first.flatMap({ screen(containing: $0.1) }) ?? screens.first else { fail("no screen") }
    let stripLeft = scr.visible.maxX - CGFloat(width)
    let strip = CGRect(x: stripLeft, y: scr.visible.minY, width: CGFloat(width), height: scr.visible.height)
    var trims: [[String: Any]] = []
    var reasons: [String] = []
    for (window, before) in frames where before.intersects(strip) {
        if before.minX >= stripLeft { reasons.append("a window lies inside the strip"); continue }
        let newWidth = stripLeft - before.minX
        if newWidth < CGFloat(minWidth) { reasons.append("a window would be narrower than \(Int(minWidth))"); continue }
        let error = axSetSize(window, CGSize(width: newWidth, height: before.height))
        usleep(120_000)
        let after = axFrame(window) ?? before
        if after.maxX > stripLeft + 1 { reasons.append("a window refused the size (AXError \(error.rawValue))") }
        if !close(after, before, 0.5) { trims.append(["before": rectJSON(before), "after": rectJSON(after)]) }
    }
    if frames.allSatisfy({ !$0.1.intersects(strip) }) { reasons.append("already clear") }
    var out = base.merging(["strip": rectJSON(strip), "trims": trims, "changed": !trims.isEmpty]) { $1 }
    if !reasons.isEmpty { out["reason"] = reasons.joined(separator: "; ") }
    emit(out)

case "restore":
    requireTrust()
    guard let pidText = option("pid"), let pid = pid_t(pidText), let frame = option("frame").flatMap(parseRect), let expect = option("expect").flatMap(parseRect) else {
        fail("restore needs --pid P --frame x,y,w,h --expect x,y,w,h")
    }
    guard let window = axWindows(pid: pid).first(where: { axFrame($0).map { close($0, expect) } ?? false }) else {
        emit(["changed": false, "reason": "no window of \(pid) is still at the expected frame"])
    }
    axSetPosition(window, frame.origin)
    axSetSize(window, frame.size)
    emit(["changed": true, "after": rectJSON(axFrame(window) ?? frame)])

case "move":
    requireTrust()
    guard let pidText = option("pid"), let pid = pid_t(pidText), let match = option("match").flatMap(parseRect), let to = option("to").flatMap(parsePoint) else {
        fail("move needs --pid P --match x,y,w,h --to x,y")
    }
    let windows = axWindows(pid: pid)
    guard let window = windows.first(where: { axFrame($0).map { close($0, match) } ?? false }) else {
        fail("no window of \(pid) at \(rectJSON(match)) (it has \(windows.count) windows: \(windows.compactMap(axFrame).map(rectJSON)))")
    }
    // Position, then size, then position again: a size applied while the window is still on a smaller
    // screen is clamped to that screen.
    axSetPosition(window, to)
    if let size = option("size").flatMap(parsePoint) {
        usleep(100_000)
        axSetSize(window, CGSize(width: size.x, height: size.y))
        axSetPosition(window, to)
    }
    usleep(100_000)
    emit(["after": rectJSON(axFrame(window) ?? .null)])

default:
    fail("unknown command \(command)")
}
