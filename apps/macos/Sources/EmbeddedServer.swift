// EmbeddedServer — the bundled DeepSea.app runs its variant's server itself.
//
// `deepsea-app.json` of a bundled build carries an `embedded` block
// (apps/macos/bundle/assemble.mjs):
//
//   "embedded": { "variant": "release", "ports": 3200, "node": "node/bin/node",
//                 "dsh": "deepsea/node_modules/@deepseek-ai/dsh/lib/bin.js",
//                 "relay": "runtime/apps/relay/relay.mjs", "homeSetup": "home-setup.mjs",
//                 "proxy": true }
//
// What an installed variant gets from launchd (LAYOUT.md §6), this app does
// itself, with the Node in its Resources:
//
//   1. home-setup.mjs: the variant's home, variant.yml (ports), the profile with
//      every bundled plugin as a bundle, the logs/support/source links — what
//      `dsd new` + `dsd build --install` write, so dsd can take the variant over.
//   2. If nothing listens on the relay port (a dsd-installed LaunchAgent, or an
//      earlier instance): start the relay (apps/relay) with the same arguments
//      dsd puts in the LaunchAgent, pointing at the bundle's dsh and plugins.
//      The relay starts `dsh web` on the first connection, keeps the standing
//      token in <home>/relay/state.json and answers a self-reloading page until
//      the server is up — the wrapper's ordinary fallbackUrl + tokenFile path
//      then logs in, nothing special for the embedded case.
//   3. On quit: SIGTERM to the relay, which stops its server's process group.
//      A relay that was already there is left alone.
//
// The relay's own log is relay/<ts>-<pid>.log under the variant's log
// directory; this app's log notes starts, exits and the home-setup result.

import Cocoa

struct EmbeddedSpec: Decodable {
    var variant: String
    var ports: Int?
    var node: String
    var dsh: String
    var relay: String
    var homeSetup: String
    var proxy: Bool?
}

final class EmbeddedServer {
    let spec: EmbeddedSpec
    let resources: URL
    let log: (String) -> Void
    private(set) var process: Process?
    /// Set once home-setup has run.
    private(set) var home: URL?
    private(set) var ports: (dsh: Int, relay: Int, proxy: Int)?
    private(set) var logDir: URL?
    /// Called when the relay this app started exits (status, last log lines).
    var onExit: ((Int32, [String]) -> Void)?
    private var stopping = false
    private var tail: [String] = []

    init(spec: EmbeddedSpec, resources: URL, log: @escaping (String) -> Void) {
        self.spec = spec
        // Symlinks resolved with realpath(3): Node compares `import.meta.url` (a real path) with argv[1]
        // to decide whether a module is the main one — the relay under /tmp (→ /private/tmp) would
        // otherwise load and exit 0. (Foundation's resolvingSymlinksInPath strips `/private` back off.)
        self.resources = EmbeddedServer.realPath(resources)
        self.log = log
    }

    static func realPath(_ url: URL) -> URL {
        guard let resolved = realpath(url.path, nil) else { return url }
        defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    }

    var node: URL { resources.appendingPathComponent(spec.node) }
    var relayURL: URL? { ports.map { URL(string: "http://127.0.0.1:\($0.relay)/")! } }
    var tokenFile: URL? { home?.appendingPathComponent("relay/state.json") }
    var relayLog: URL? { logDir?.appendingPathComponent("relay") }

    /// Step 1: the home and ports. Synchronous (well under a second); throws with the script's stderr.
    func prepareHome() throws {
        let setup = Process()
        setup.executableURL = node
        var args = [resources.appendingPathComponent(spec.homeSetup).path, "--variant", spec.variant, "--resources", resources.path]
        if let ports = spec.ports { args += ["--ports", String(ports)] }
        setup.arguments = args
        let out = Pipe(), err = Pipe()
        setup.standardOutput = out
        setup.standardError = err
        try setup.run()
        setup.waitUntilExit()
        let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard setup.terminationStatus == 0,
              let data = stdout.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let homePath = json["home"] as? String,
              let p = json["ports"] as? [String: Any],
              let dsh = p["dsh"] as? Int, let relay = p["relay"] as? Int, let proxy = p["proxy"] as? Int,
              let logPath = json["logDir"] as? String else {
            throw NSError(domain: "DeepSea", code: 1, userInfo: [NSLocalizedDescriptionKey: "home-setup failed (status \(setup.terminationStatus)): \(stderr.trimmingCharacters(in: .whitespacesAndNewlines).suffix(600))"])
        }
        home = URL(fileURLWithPath: homePath, isDirectory: true)
        ports = (dsh, relay, proxy)
        logDir = URL(fileURLWithPath: logPath, isDirectory: true)
        log("embedded: home \(homePath), ports \(dsh)/\(relay)/\(proxy), bundles \(json["bundles"] ?? 0)\((json["created"] as? Bool) == true ? " (created)" : "")")
    }

    /// Whether something already accepts connections on the relay port (a dsd-installed relay, an earlier instance).
    func relayListening() -> Bool {
        guard let ports else { return false }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(ports.relay).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        return result == 0
    }

    /// Step 2: the relay, unless one is listening already. Returns whether this app started one.
    @discardableResult
    func start() -> Bool {
        guard let home, let ports, let logDir else { return false }
        if relayListening() {
            log("embedded: a relay already listens on \(ports.relay); using it")
            return false
        }
        let p = Process()
        p.executableURL = node
        var args = [resources.appendingPathComponent(spec.relay).path,
                    "--variant", spec.variant, "--home", home.path,
                    "--listen", "127.0.0.1:\(ports.relay)", "--dsh", "127.0.0.1:\(ports.dsh)"]
        if spec.proxy == true { args += ["--proxy", "127.0.0.1:\(ports.proxy)"] }
        args += ["--log-dir", logDir.path, "--cwd", resources.appendingPathComponent("deepsea").path,
                 "--", node.path, resources.appendingPathComponent(spec.dsh).path, "--profile", "web", "--no-open", "--port", String(ports.dsh)]
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["DEEPSEA_VARIANT"] = spec.variant
        env["DSH_HOME"] = home.path
        // Inherited by the server the relay starts: the app-setup plugin arms itself on these.
        env["DEEPSEA_APP_BUNDLE"] = resources.path
        env["DEEPSEA_APP_VERSION"] = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        env["DEEPSEA_APP_BUILD"] = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        // The bundled Node first, so `node` inside the server resolves to the one that runs it.
        // The bundled Node first, so `node` inside the server resolves to the one that runs it; then the tools the
        // app-setup plugin installs for this variant (afm); the login shell the relay uses appends the person's PATH.
        env["PATH"] = node.deletingLastPathComponent().path + ":" + home.appendingPathComponent("plugins/app-setup/bin").path + ":" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env
        p.currentDirectoryURL = resources.appendingPathComponent("deepsea")
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        tail = []
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                for line in text.split(separator: "\n") where !line.isEmpty {
                    self.tail.append(String(line))
                    if self.tail.count > 40 { self.tail.removeFirst(self.tail.count - 40) }
                    self.log("relay: \(line)")
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.log("embedded: relay exited with status \(proc.terminationStatus)")
                self.process = nil
                if !self.stopping { self.onExit?(proc.terminationStatus, self.tail) }
            }
        }
        do {
            try p.run()
            process = p
            log("embedded: started the relay (pid \(p.processIdentifier)) for \(spec.variant) on \(ports.relay) → dsh \(ports.dsh)")
            return true
        } catch {
            log("embedded: cannot start the relay: \(error.localizedDescription)")
            onExit?(-1, [error.localizedDescription])
            return false
        }
    }

    /// Step 3: stop the relay this app started (SIGTERM; the relay stops its server's process group). Waits up to 8 s.
    func stop() {
        guard let p = process, p.isRunning else { return }
        stopping = true
        log("embedded: stopping the relay (pid \(p.processIdentifier))")
        p.terminate()
        let deadline = Date().addingTimeInterval(8)
        while p.isRunning && Date() < deadline { usleep(50_000) }
        if p.isRunning {
            log("embedded: relay did not exit in 8 s; SIGKILL")
            kill(p.processIdentifier, SIGKILL)
        }
    }
}
