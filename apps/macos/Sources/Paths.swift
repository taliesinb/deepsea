// Where the app writes its own files (LAYOUT.md §5):
//
//   ~/Library/Logs/<variant name>/                 0700; <variant name> is the bundle id
//     app/<ts>-<pid>.log                            one file per run; first line names the run
//     app/latest.log -> <ts>-<pid>.log
//     app/snapshots/window-<ts>-<pid>.png           View ▸ Save Window Snapshot, `kill -USR1 <pid>` (a link)
//     app/snapshots/element-<ts>-<pid>/             View ▸ Save Element Snapshot, the automation `snapshot`
//                                                   (PNGs are links; element.json / element.md are files)
//     app/snapshots/latest-window.png, latest-element
//     app/snapshots/images/<sha256>.png             every image once, content-addressed
//
// `DEEPSEA_LOG_ROOT` replaces ~/Library/Logs (tests and sandboxes). At start the
// app keeps its newest 20 run logs plus any younger than 14 days, and its
// newest 50 snapshots; images no snapshot links to are removed with them.

import CryptoKit
import Foundation

/// Process start, as close as the app can observe it.
let appLaunchDate = Date()

enum AppPaths {
    /// The bare reverse-DNS root; a variant's name is `<root>.<variant id>`, also its bundle id.
    static let root = "io.github.taliesinb.deepsea"
    static let keptRuns = 20
    static let keptRunAge: TimeInterval = 14 * 24 * 3600
    static let keptSnapshots = 50

    /// This app's variant name: its bundle id (`io.github.taliesinb.deepsea.<v>`).
    static var variantName: String {
        guard let id = Bundle.main.bundleIdentifier, id.hasPrefix(root + "."), id.count > root.count + 1 else { return root + ".unknown" }
        return id
    }

    /// `~/Library/Logs`, or `DEEPSEA_LOG_ROOT`.
    static var logRoot: URL {
        if let custom = ProcessInfo.processInfo.environment["DEEPSEA_LOG_ROOT"], !custom.isEmpty {
            return URL(fileURLWithPath: NSString(string: custom).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs", isDirectory: true)
    }

    /// A directory under the variant's log directory (0700 at the variant level), created on demand.
    static func directory(_ components: String...) -> URL {
        let fm = FileManager.default
        let variant = logRoot.appendingPathComponent(variantName, isDirectory: true)
        if !fm.fileExists(atPath: variant.path) {
            try? fm.createDirectory(at: variant, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let dir = components.reduce(variant) { $0.appendingPathComponent($1, isDirectory: true) }
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static var appDirectory: URL { directory("app") }
    static var snapshotsDirectory: URL { directory("app", "snapshots") }
    static var imagesDirectory: URL { directory("app", "snapshots", "images") }

    /// Store `png` as images/<sha256>.png (skipped when that file exists). Returns the hash and file.
    static func storeImage(_ png: Data) throws -> (sha256: String, url: URL) {
        let hash = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        let url = imagesDirectory.appendingPathComponent("\(hash).png")
        if !FileManager.default.fileExists(atPath: url.path) { try png.write(to: url, options: .atomic) }
        return (hash, url)
    }

    /// A relative symlink at `link` to `target`, replacing whatever is there.
    static func symlink(_ link: URL, to target: URL) throws {
        let from = link.deletingLastPathComponent().resolvingSymlinksInPath().pathComponents
        let to = target.resolvingSymlinksInPath().pathComponents
        var common = 0
        while common < from.count, common < to.count - 1, from[common] == to[common] { common += 1 }
        let relative = Array(repeating: "..", count: from.count - common) + to[common...]
        try? FileManager.default.removeItem(at: link)
        try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: relative.joined(separator: "/"))
    }

    /// Local time, sortable and filename-safe: `2026-10-07T19-04-14`.
    static func stamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
        return f.string(from: date)
    }

    /// ISO 8601 with the local offset; `fraction` adds milliseconds (JSON records).
    static func iso(_ date: Date, fraction: Bool = false) -> String {
        let f = ISO8601DateFormatter()
        f.timeZone = .current
        f.formatOptions = fraction ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return f.string(from: date)
    }

    /// `<dir>/<stem>` or, when taken, `<stem>-2`, `<stem>-3`, … (`ext` appended to each candidate).
    static func unique(in dir: URL, stem: String, ext: String = "") -> URL {
        let name = { (n: Int) in (n == 1 ? stem : "\(stem)-\(n)") + (ext.isEmpty ? "" : ".\(ext)") }
        var n = 1
        while FileManager.default.fileExists(atPath: dir.appendingPathComponent(name(n)).path) { n += 1 }
        return dir.appendingPathComponent(name(n))
    }

    /// Point `link` at `target` (relative when both share a directory).
    static func pointLatest(link: URL, to target: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: link)
        let destination = link.deletingLastPathComponent().path == target.deletingLastPathComponent().path ? target.lastPathComponent : target.path
        try? fm.createSymbolicLink(atPath: link.path, withDestinationPath: destination)
    }

    /// This run's log, created with its identity line, `latest.log` pointed at it, and old runs pruned.
    static func openRunLog(identity: String) -> URL {
        let dir = appDirectory
        let url = dir.appendingPathComponent("\(stamp(appLaunchDate))-\(getpid()).log")
        FileManager.default.createFile(atPath: url.path, contents: Data("\(iso(appLaunchDate)) \(identity)\n".utf8))
        pointLatest(link: dir.appendingPathComponent("latest.log"), to: url)
        prune(dir, keep: keptRuns, maxAge: keptRunAge, sparing: url) { $0.hasSuffix(".log") && $0 != "latest.log" }
        pruneSnapshots()
        return url
    }

    /// Delete matching entries of `dir` beyond the newest `keep` (names sort by time), sparing those younger than `maxAge`.
    static func prune(_ dir: URL, keep: Int, maxAge: TimeInterval?, sparing: URL? = nil, where matches: (String) -> Bool) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
        let now = Date()
        for name in names.filter(matches).sorted().dropLast(keep) where name != sparing?.lastPathComponent {
            let url = dir.appendingPathComponent(name)
            if let maxAge, let modified = (try? fm.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
               now.timeIntervalSince(modified) < maxAge { continue }
            try? fm.removeItem(at: url)
        }
    }

    /// Keep the newest snapshots; drop images nothing links to any more.
    static func pruneSnapshots() {
        let fm = FileManager.default
        let dir = snapshotsDirectory
        prune(dir, keep: keptSnapshots, maxAge: nil) { $0.hasPrefix("window-") || $0.hasPrefix("element-") }
        var linked = Set<String>()
        let remaining = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        for name in remaining where name.hasPrefix("window-") || name.hasPrefix("element-") {
            let url = dir.appendingPathComponent(name)
            let links = name.hasPrefix("element-") ? ((try? fm.contentsOfDirectory(atPath: url.path)) ?? []).map { url.appendingPathComponent($0) } : [url]
            for link in links { if let target = try? fm.destinationOfSymbolicLink(atPath: link.path) { linked.insert((target as NSString).lastPathComponent) } }
        }
        for image in (try? fm.contentsOfDirectory(atPath: imagesDirectory.path)) ?? [] where !linked.contains(image) {
            try? fm.removeItem(at: imagesDirectory.appendingPathComponent(image))
        }
    }
}
