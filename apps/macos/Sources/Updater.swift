// In-app updates for the bundled DeepSea.app from GitHub Releases —
// hand-rolled rather than Sparkle: no framework, no appcast, no signing
// requirement (the app is ad-hoc signed; a bundle the app itself downloads
// carries no quarantine flag, so the swap launches without Gatekeeper).
//
// Configured by the `update` block of deepsea-app.json (assemble.mjs):
//   "update": { "repo": "taliesinb/deepsea", "channel": "release", "intervalHours": 6,
//               "feed": null }          // feed overrides the GitHub URL (testing)
//
// Protocol (produced by tools/bundle/release.mjs):
//   GET https://api.github.com/repos/<repo>/releases?per_page=30  → the newest of this channel, with
//     tag_name  "<channel>-<build>"   channel = the variant; build = integer, compared with CFBundleVersion
//     name      "DeepSea 2026.10.22"
//     body      release notes (shown in the prompt)
//     assets[]  one *.dmg and its sibling *.dmg.sha256 (hex digest, first word)
// Install: download the DMG to a temp dir (progress window), verify sha256,
// `hdiutil attach -nobrowse -readonly`, copy `<Name>.app` beside the running
// bundle, move the running bundle to the Trash, rename the copy into place,
// detach, `open` the new bundle and terminate (which stops the embedded
// server). Refused when the app runs translocated (from a DMG) or from a
// directory it cannot write — then the user is told to move it to Applications.
// A version can be skipped (UserDefaults `deepsea.update.skipBuild`).

import Cocoa
import CryptoKit

struct UpdateSpec: Decodable {
    var repo: String
    /// The release channel: the variant (`release`, `canary`). Tags are `<channel>-<build>`, so a
    /// canary never replaces itself with a release build or the other way round.
    var channel: String?
    var intervalHours: Double?
    var feed: String?
    /// For a PRIVATE release repo, the preferred way in: the client id of a GitHub App with
    /// Contents: read on that repo and Device Flow enabled. When the feed cannot be read the
    /// app offers "Sign in…" (SignIn.swift); the user token is kept in Application Support.
    var clientId: String?
    /// The GitHub App's client secret for the web-flow code exchange (GitHub requires it even
    /// with PKCE; the callback is pinned to loopback). Absent → the device flow is used.
    var clientSecret: String?
    /// Test seam: the GitHub web origin for the sign-in flows (default https://github.com).
    var oauthBase: String?
}

struct ReleaseInfo {
    let build: Int
    let name: String
    let notes: String
    let dmgURL: URL
    let shaURL: URL?
    let dmgSize: Int
}

enum UpdateError: LocalizedError {
    case badFeed(String), noAsset, checksum, mount(String), translocated, unwritable(String), copy(String)
    var errorDescription: String? {
        switch self {
        case .badFeed(let why): return "The release feed could not be read: \(why)"
        case .noAsset: return "The latest release carries no .dmg asset."
        case .checksum: return "The downloaded image does not match its published SHA-256; not installing it."
        case .mount(let why): return "The disk image could not be mounted: \(why)"
        case .translocated: return "This copy runs from a disk image (or is translocated). Move it to Applications, launch it from there, then update."
        case .unwritable(let dir): return "The app's folder (\(dir)) is not writable, so it cannot be replaced. Move the app to your Applications folder."
        case .copy(let why): return "Installing the new version failed: \(why)"
        }
    }
}

final class Updater: NSObject {
    let spec: UpdateSpec
    let appName: String
    let log: (String) -> Void
    private var timer: Timer?
    private var busy = false
    private var progressWindow: NSWindow?
    private var progressBar: NSProgressIndicator?
    private var progressLabel: NSTextField?
    private var session: URLSession?
    private static let skipKey = "deepsea.update.skipBuild"
    /// `defaults write <bundle id> deepsea.update.autoInstall -bool true`: install without the prompt (headless testing).
    private static let autoInstallKey = "deepsea.update.autoInstall"

    init(spec: UpdateSpec, appName: String, log: @escaping (String) -> Void) {
        self.spec = spec
        self.appName = appName
        self.log = log
    }

    /// CFBundleVersion as an integer build number (0 when unset — a dev build always sees updates).
    var currentBuild: Int { Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "") ?? 0 }
    var currentVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
    var channel: String { spec.channel ?? "release" }

    var feedURL: URL {
        if let feed = spec.feed, let url = URL(string: feed) { return url }
        return URL(string: "https://api.github.com/repos/\(spec.repo)/releases?per_page=30")!
    }

    /// Start the periodic check: first one after `delay`, then every intervalHours.
    func schedule(delay: TimeInterval = 10) {
        let hours = spec.intervalHours ?? 6
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.check(userInitiated: false) }
        timer = Timer.scheduledTimer(withTimeInterval: max(hours, 0.25) * 3600, repeats: true) { [weak self] _ in self?.check(userInitiated: false) }
    }

    // MARK: check

    @objc func checkNow() { check(userInitiated: true) }

    func check(userInitiated: Bool) {
        guard !busy else { return }
        var request = URLRequest(url: feedURL)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("deepsea-updater/\(currentBuild)", forHTTPHeaderField: "User-Agent")
        let usedSource = bearer()?.source
        if let usedSource { log("update: reading the feed with the \(usedSource.rawValue)") }
        authorize(&request)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 15
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                do {
                    if let error { throw UpdateError.badFeed(error.localizedDescription) }
                    guard let http = response as? HTTPURLResponse, let data else { throw UpdateError.badFeed("no response") }
                    if http.statusCode == 401 || http.statusCode == 404 {
                        // 401: what we sent is not a valid credential → drop it (a stored sign-in is deleted) and
                        //      try the next way in; when nothing is left, offer the sign-in.
                        // 404: GitHub hides the repo from this credential. For a stored sign-in that is "the app
                        //      is not installed on the organisation yet" — the token is fine, keep it, say so.
                        //      For anything else, try the next way in, then offer the sign-in.
                        if let used = usedSource {
                            self.log("update: feed answered HTTP \(http.statusCode) with the \(used.rawValue)")
                            self.rejected.insert(used)
                            if used == .signIn, http.statusCode == 401 { self.clearStoredToken() }
                            if self.bearer() != nil { self.check(userInitiated: userInitiated); return }
                            if used == .signIn, http.statusCode == 404 {
                                throw UpdateError.badFeed("your GitHub sign-in is valid, but the app is not installed on the repository yet — an organisation owner must install it")
                            }
                        }
                        if self.storedToken() != nil {
                            // Signed in already (and that token was not invalid, or it would be gone): the repo is simply not reachable for it.
                            throw UpdateError.badFeed("your GitHub sign-in is valid, but the app is not installed on the repository yet — an organisation owner must install it")
                        }
                        if self.spec.clientId != nil {
                            // After signing in, check as if the user asked: the normal "update available" prompt
                            // (or "up to date") follows — never a silent install.
                            self.offerSignIn(userInitiated: userInitiated) { ok in if ok { self.check(userInitiated: true) } }
                            return
                        }
                    }
                    guard http.statusCode == 200 else { throw UpdateError.badFeed("HTTP \(http.statusCode)") }
                    let info = try Updater.parse(data, channel: self.channel, appName: self.appName, viaAPI: self.bearer() != nil)
                    self.log("update: latest build \(info.build) (\(info.name)); running \(self.currentBuild)")
                    if info.build > self.currentBuild {
                        let skipped = UserDefaults.standard.integer(forKey: Updater.skipKey)
                        if !userInitiated && skipped == info.build { return }
                        self.offer(info)
                    } else if userInitiated {
                        let alert = NSAlert()
                        alert.messageText = "\(self.appName) is up to date"
                        alert.informativeText = "Version \(self.currentVersion) (build \(self.currentBuild)) is the latest release."
                        alert.runModal()
                    }
                } catch {
                    self.log("update: check failed: \(error.localizedDescription)")
                    if userInitiated { self.fail(error) }
                }
            }
        }.resume()
    }

    /// Accepts either one release object or a list of them; picks the newest
    /// non-draft, non-prerelease whose tag is `<channel>-<build>` and whose DMG
    /// is named for this app (`<App-Name>-…dmg`, spaces as dashes).
    // MARK: feed authentication — stored sign-in → the user's gh login → anonymous (→ offer Sign in…)

    enum Source: String { case signIn = "GitHub sign-in", gh = "gh login" }
    private var rejected: Set<Source> = []
    private var ghToken: String?? = nil
    private var promptedThisLaunch = false
    private static let declinedKey = "deepsea.update.signInDeclined"

    /// Where the device-flow token lives: outside the bundle (survives updates), 0600.
    /// Not the Keychain: an ad-hoc signed app's identity is its cdhash, which changes
    /// with every update, so Keychain ACLs would prompt or refuse after each one.
    private var tokenFile: URL {
        let id = Bundle.main.bundleIdentifier ?? "io.github.taliesinb.deepsea"
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(id, isDirectory: true)
        return dir.appendingPathComponent("github-token-" + spec.repo.replacingOccurrences(of: "/", with: "_"))
    }
    private func storedToken() -> String? {
        guard let t = try? String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }
    private func storeToken(_ token: String) {
        try? FileManager.default.createDirectory(at: tokenFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? token.write(to: tokenFile, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenFile.path)
    }
    private func clearStoredToken() { try? FileManager.default.removeItem(at: tokenFile) }

    /// The bearer to use now and where it came from (for the log; never the token itself).
    func bearer() -> (token: String, source: Source)? {
        if !rejected.contains(.signIn), let t = storedToken() { return (t, .signIn) }
        if !rejected.contains(.gh) {
            if ghToken == nil { ghToken = .some(Updater.readGhToken()) }
            if case .some(let t?) = ghToken { return (t, .gh) }
        }
        return nil
    }

    func authorize(_ request: inout URLRequest) {
        if let b = bearer() { request.setValue("Bearer \(b.token)", forHTTPHeaderField: "Authorization") }
    }

    /// The token of the user's own GitHub CLI login, if `gh` is installed and signed in.
    /// Through the login shell so Homebrew's / nix's PATH applies (a GUI app's own PATH
    /// is the bare system one); `gh auth token` prints without prompting.
    static func readGhToken() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v gh >/dev/null 2>&1 && exec gh auth token 2>/dev/null"]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let group = DispatchGroup(); group.enter()
        DispatchQueue.global().async { p.waitUntilExit(); group.leave() }
        if group.wait(timeout: .now() + .seconds(10)) == .timedOut { p.terminate(); return nil }
        guard p.terminationStatus == 0 else { return nil }
        let token = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return token.isEmpty ? nil : token
    }

    // MARK: "Sign in…" (GitHubSignIn: web flow with a loopback callback, device flow as fallback)

    private var oauthBase: String { spec.oauthBase ?? "https://github.com" }
    private var signIn: GitHubSignIn?
    private var mainWindow: NSWindow? { NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible && !($0 is NSPanel) } }

    /// Offer the sign-in as a sheet; `then(true)` once a token is stored. Automatic checks ask at most
    /// once per launch and never again after "Not now"; Check for Updates… always asks.
    private func offerSignIn(userInitiated: Bool, then: @escaping (Bool) -> Void) {
        guard let clientId = spec.clientId else { then(false); return }
        if !userInitiated {
            if promptedThisLaunch || UserDefaults.standard.bool(forKey: Updater.declinedKey) { then(false); return }
            promptedThisLaunch = true
        }
        let alert = NSAlert()
        alert.messageText = "Sign in to GitHub for \(appName) updates?"
        alert.informativeText = "Updates for \(appName) are published privately."
        alert.addButton(withTitle: "Sign in…")
        alert.addButton(withTitle: "Not now")
        let proceed: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard let self else { return }
            guard response == .alertFirstButtonReturn else {
                if !userInitiated { UserDefaults.standard.set(true, forKey: Updater.declinedKey) }
                then(false); return
            }
            UserDefaults.standard.removeObject(forKey: Updater.declinedKey)
            let flow = GitHubSignIn(clientId: clientId, clientSecret: self.spec.clientSecret, oauthBase: self.oauthBase,
                                    appName: self.appName, userAgent: "deepsea-updater/\(self.currentBuild)", log: self.log)
            self.signIn = flow
            flow.start(on: self.mainWindow) { [weak self] token in
                guard let self else { return }
                self.signIn = nil
                guard let token else { then(false); return }
                self.storeToken(token)
                self.rejected.remove(.signIn)
                self.log("update: signed in to GitHub; token stored at \(self.tokenFile.path)")
                then(true)
            }
        }
        if let window = mainWindow { alert.beginSheetModal(for: window, completionHandler: proceed) } else { proceed(alert.runModal()) }
    }


    /// The newest release of this channel: a non-draft, non-prerelease entry whose tag is
    /// `<channel>-<build>` and whose DMG is named for this app (`<Name-with-dashes>-…dmg`),
    /// so one repository can publish every variant's releases side by side.
    /// `viaAPI`: use each asset's API `url` (fetched with `Accept: application/octet-stream`) instead of its
    /// browser URL — what a private repository needs: the browser URL wants a web session and 404s.
    static func parse(_ data: Data, channel: String, appName: String, viaAPI: Bool = false) throws -> ReleaseInfo {
        let any = try JSONSerialization.jsonObject(with: data)
        let releases: [[String: Any]]
        if let list = any as? [[String: Any]] { releases = list }
        else if let one = any as? [String: Any] { releases = [one] }
        else { throw UpdateError.badFeed("not a JSON object or array") }
        let prefix = channel + "-"
        let dmgPrefix = appName.replacingOccurrences(of: " ", with: "-") + "-"
        var best: ReleaseInfo?
        for json in releases {
            guard let tag = json["tag_name"] as? String, tag.hasPrefix(prefix) else { continue }
            if json["draft"] as? Bool == true || json["prerelease"] as? Bool == true { continue }
            guard let build = Int(tag.dropFirst(prefix.count)) else { continue }
            let assets = json["assets"] as? [[String: Any]] ?? []
            guard let dmg = assets.first(where: { asset in
                      let n = asset["name"] as? String ?? ""
                      return n.hasSuffix(".dmg") && n.hasPrefix(dmgPrefix)
                  }),
                  let dmgURL = (dmg[viaAPI ? "url" : "browser_download_url"] as? String).flatMap(URL.init(string:)) else { continue }
            let dmgName = dmg["name"] as? String ?? ""
            let sha = assets.first(where: { ($0["name"] as? String) == dmgName + ".sha256" })
            let shaURL = (sha?[viaAPI ? "url" : "browser_download_url"] as? String).flatMap(URL.init(string:))
            let info = ReleaseInfo(build: build, name: json["name"] as? String ?? tag, notes: json["body"] as? String ?? "",
                                   dmgURL: dmgURL, shaURL: shaURL, dmgSize: dmg["size"] as? Int ?? 0)
            if best == nil || info.build > best!.build { best = info }
        }
        guard let found = best else { throw UpdateError.noAsset }
        return found
    }

    // MARK: offer

    private func offer(_ info: ReleaseInfo) {
        if UserDefaults.standard.bool(forKey: Updater.autoInstallKey) {
            log("update: autoInstall set; installing build \(info.build) without prompting")
            install(info)
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "\(info.name) is available"
        var detail = "You have \(currentVersion) (build \(currentBuild))."
        if info.dmgSize > 0 { detail += " The download is \(ByteCountFormatter.string(fromByteCount: Int64(info.dmgSize), countStyle: .file))." }
        let notes = info.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if !notes.isEmpty { detail += "\n\n" + String(notes.prefix(1200)) }
        alert.informativeText = detail
        alert.addButton(withTitle: "Install and Relaunch")
        alert.addButton(withTitle: "Later")
        alert.addButton(withTitle: "Skip This Version")
        switch alert.runModal() {
        case .alertFirstButtonReturn: install(info)
        case .alertThirdButtonReturn: UserDefaults.standard.set(info.build, forKey: Updater.skipKey)
        default: break
        }
    }

    // MARK: install

    private func install(_ info: ReleaseInfo) {
        do { try preflight() } catch { fail(error); return }
        busy = true
        showProgress("Downloading \(info.name)…")
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("deepsea-update-\(info.build)", isDirectory: true)
        try? FileManager.default.removeItem(at: staging)
        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let dmgPath = staging.appendingPathComponent(info.dmgURL.lastPathComponent)

        fetchText(info.shaURL) { [weak self] expectedSha in
            guard let self else { return }
            let delegate = DownloadDelegate(progress: { [weak self] fraction in
                self?.progress(.download, fraction)
            }, finished: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .failure(let error):
                        self.finish(error: error)
                    case .success(let tmp):
                        do {
                            try? FileManager.default.removeItem(at: dmgPath)
                            try FileManager.default.moveItem(at: tmp, to: dmgPath)
                            self.progressLabel?.stringValue = "Verifying…"
                            self.progress(.verify, 0)
                            try self.verify(dmgPath, expectedSha: expectedSha)
                            self.progress(.verify, 1)
                            self.progressLabel?.stringValue = "Installing…"
                            DispatchQueue.global(qos: .userInitiated).async {
                                let outcome = Result { try self.swap(dmg: dmgPath, staging: staging) }
                                DispatchQueue.main.async {
                                    switch outcome {
                                    case .success(let newApp): self.relaunch(newApp)
                                    case .failure(let error): self.finish(error: error)
                                    }
                                }
                            }
                        } catch {
                            self.finish(error: error)
                        }
                    }
                }
            })
            let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
            self.session = session
            var request = URLRequest(url: info.dmgURL)
            request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")   // an API asset `url` answers the bytes only with this
            request.setValue("deepsea-updater/\(currentBuild)", forHTTPHeaderField: "User-Agent")
            authorize(&request)
            session.downloadTask(with: request).resume()
        }
    }

    /// One bar for the whole update: download 0–60 %, verify 60–65 %, install 65–98 %, relaunch 100.
    enum Phase { case download, verify, install }
    private func progress(_ phase: Phase, _ fraction: Double) {
        let (from, to): (Double, Double)
        switch phase {
        case .download: (from, to) = (0, 60)
        case .verify: (from, to) = (60, 65)
        case .install: (from, to) = (65, 98)
        }
        let value = from + (to - from) * min(max(fraction, 0), 1)
        if Thread.isMainThread { progressBar?.doubleValue = value }
        else { DispatchQueue.main.async { self.progressBar?.doubleValue = value } }
    }

    /// Recursive copy reporting bytes copied over bytes total (a first pass sizes the tree).
    private func copyTree(from source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]
        var total: Int64 = 0
        var entries: [(URL, URLResourceValues)] = []
        if let walk = fm.enumerator(at: source, includingPropertiesForKeys: keys, options: []) {
            for case let url as URL in walk {
                let values = try url.resourceValues(forKeys: Set(keys))
                entries.append((url, values))
                if values.isDirectory != true, values.isSymbolicLink != true { total += Int64(values.fileSize ?? 0) }
            }
        }
        var done: Int64 = 0
        var lastReport = Date.distantPast
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        let base = source.standardizedFileURL.path
        for (url, values) in entries {
            let relative = String(url.standardizedFileURL.path.dropFirst(base.count)).drop(while: { $0 == "/" })
            let target = destination.appendingPathComponent(String(relative))
            if values.isSymbolicLink == true {
                try fm.createSymbolicLink(atPath: target.path, withDestinationPath: try fm.destinationOfSymbolicLink(atPath: url.path))
            } else if values.isDirectory == true {
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
            } else {
                try fm.copyItem(at: url, to: target)
                done += Int64(values.fileSize ?? 0)
                if Date().timeIntervalSince(lastReport) > 0.05 {
                    lastReport = Date()
                    progress(.install, total == 0 ? 1 : Double(done) / Double(total))
                }
            }
        }
        progress(.install, 1)
    }

    private func preflight() throws {
        let bundle = Bundle.main.bundleURL
        if bundle.path.contains("/AppTranslocation/") || bundle.path.hasPrefix("/Volumes/") { throw UpdateError.translocated }
        let parent = bundle.deletingLastPathComponent()
        if !FileManager.default.isWritableFile(atPath: parent.path) { throw UpdateError.unwritable(parent.path) }
    }

    private func fetchText(_ url: URL?, completion: @escaping (String?) -> Void) {
        guard let url else { completion(nil); return }
        var request = URLRequest(url: url)
        request.setValue("deepsea-updater/\(currentBuild)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        authorize(&request)
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let text = data.flatMap { String(data: $0, encoding: .utf8) }
            DispatchQueue.main.async { completion(text) }
        }.resume()
    }

    private func verify(_ dmg: URL, expectedSha: String?) throws {
        guard let expectedSha else {
            log("update: no .sha256 asset published; installing unverified")
            return
        }
        let expected = expectedSha.split(whereSeparator: { $0 == " " || $0 == "\n" }).first.map(String.init)?.lowercased() ?? ""
        let data = try Data(contentsOf: dmg, options: .mappedIfSafe)
        let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == expected else {
            log("update: sha256 mismatch expected \(expected) got \(actual)")
            throw UpdateError.checksum
        }
    }

    /// Mount, copy the new bundle beside ours, Trash ours, rename the copy into place, detach. Returns the installed bundle URL.
    private func swap(dmg: URL, staging: URL) throws -> URL {
        let mount = staging.appendingPathComponent("mount", isDirectory: true)
        let attach = run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount.path, dmg.path])
        guard attach.status == 0 else { throw UpdateError.mount(attach.output) }
        defer { _ = run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"]) }
        let fm = FileManager.default
        guard let appInImage = (try? fm.contentsOfDirectory(at: mount, includingPropertiesForKeys: nil))?.first(where: { $0.pathExtension == "app" }) else {
            throw UpdateError.copy("the image contains no .app")
        }
        let current = Bundle.main.bundleURL
        let parent = current.deletingLastPathComponent()
        let incoming = parent.appendingPathComponent(".\(current.lastPathComponent).update-\(UUID().uuidString.prefix(8))")
        // Copied file by file so the bar moves: 260 MB over a few thousand files
        // is the slow part, and `cp -R` reports nothing. Symlinks are recreated,
        // permissions and extended attributes come with `copyItem` per file, and
        // `codesign --verify --deep` below is the proof the result is intact.
        try copyTree(from: appInImage, to: incoming)
        let verify = run("/usr/bin/codesign", ["--verify", "--deep", incoming.path])
        guard verify.status == 0 else { try? fm.removeItem(at: incoming); throw UpdateError.copy("the copied bundle fails codesign --verify: \(verify.output)") }
        do {
            try fm.trashItem(at: current, resultingItemURL: nil)
        } catch {
            // Trash unavailable (network volume, odd permissions): rename aside instead.
            let aside = parent.appendingPathComponent("\(current.deletingPathExtension().lastPathComponent) (old).app")
            try? fm.removeItem(at: aside)
            try fm.moveItem(at: current, to: aside)
        }
        try fm.moveItem(at: incoming, to: current)
        return current
    }

    private func relaunch(_ app: URL) {
        log("update: installed \(app.path); relaunching")
        progressLabel?.stringValue = "Relaunching…"
        progressBar?.doubleValue = 100
        // `open` after this process has exited, so LSMultipleInstancesProhibited does not refuse the new copy.
        let script = "while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done; /usr/bin/open \"\(app.path)\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        try? p.run()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }

    private func finish(error: Error) {
        busy = false
        session?.invalidateAndCancel()
        session = nil
        progressWindow?.close()
        progressWindow = nil
        log("update: failed: \(error.localizedDescription)")
        fail(error)
    }

    private func fail(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Update failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: progress window

    private func showProgress(_ title: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 96), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Updating \(appName)"
        window.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: 20, y: 56, width: 380, height: 20)
        let bar = NSProgressIndicator(frame: NSRect(x: 20, y: 24, width: 380, height: 20))
        bar.style = .bar
        bar.minValue = 0
        bar.maxValue = 100
        bar.isIndeterminate = false
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(bar)
        window.center()
        window.makeKeyAndOrderFront(nil)
        progressWindow = window
        progressBar = bar
        progressLabel = label
    }

    private func run(_ tool: String, _ args: [String]) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
    }
}

private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
    let progress: (Double) -> Void
    let finished: (Result<URL, Error>) -> Void
    init(progress: @escaping (Double) -> Void, finished: @escaping (Result<URL, Error>) -> Void) {
        self.progress = progress
        self.finished = finished
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let fraction = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        DispatchQueue.main.async { self.progress(fraction) }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temp file is deleted when this returns: move it somewhere durable first.
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent("deepsea-update-\(UUID().uuidString).dmg")
        do {
            try FileManager.default.moveItem(at: location, to: kept)
            if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
                finished(.failure(UpdateError.badFeed("download HTTP \(http.statusCode)")))
            } else {
                finished(.success(kept))
            }
        } catch {
            finished(.failure(error))
        }
        session.finishTasksAndInvalidate()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finished(.failure(error)) }
    }
}
