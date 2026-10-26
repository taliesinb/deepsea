// Loopback port forwarding — the client half of "an agent on the remote said
// `http://127.0.0.1:5173/`; make that link work here".
//
// The page inside this app runs on another Mac, so a loopback URL it shows
// refers to *that* machine. When such a URL is about to load (an iframe the
// GUI's Sidebar Browser opens, a link click, a window.open), the AppDelegate
// asks `PortForwarder.ensure(remotePort:)` first: it opens one WebSocket to the
// remote's `<mount>api/deepsea-tailscale/loopback-forward?port=<n>` (the tailscale plugin's
// forward route) as a probe — the remote answers with an HTTP status when the
// port is refused (not ours, nothing listening, reserved) and with a
// `{"type":"connected"}` text frame when it is forwardable — then binds
// `127.0.0.1:<n>` on this Mac (a free port when <n> is taken here). Every TCP
// connection accepted on that listener becomes one more WebSocket to the same
// endpoint; bytes are piped as binary frames both ways. The URL the agent
// printed then works verbatim: same Host header, absolute paths, cookies and
// HMR sockets included.
//
// The WebSocket rides the same authority the page uses, so it is admitted the
// same way: Tailscale identity headers are injected by tailscaled for any
// connection from this node, and the proxy cookie (token-exchanged fallback
// entry) is copied from the WKWebView's cookie store onto the request.
//
// Listeners live until the app quits, the user closes them from the View ▸
// Forwarded Ports menu, or they sit idle (no connection) for an hour.
//
// A forward goes through the server of the page that asked (`via`): the app's
// own mount, or a remote session framed through remote-workspaces
// (`<mount>deepsea-remote-workspaces/servers/<id>/`, whose egress passes the
// forward route on to that server). A sign-in's callback port (the loopback
// `redirect_uri` of an OAuth page) is forwarded on exactly its own port, since
// the redirect names it, and single-use: the listener closes once the callback
// has gone through, or after ten minutes, so it never holds the port against a
// later sign-in on this Mac.

import Foundation
import Network
import WebKit

/// A URL that names a loopback service — on the remote, from this app's point of view.
struct LoopbackLink {
    let url: URL
    let port: Int

    static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "0:0:0:0:0:0:0:1"]

    static func isLoopbackHost(_ raw: String) -> Bool {
        let host = raw.lowercased()
        return loopbackHosts.contains(host) || host.hasPrefix("127.") || host.hasSuffix(".localhost")
    }

    init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        guard let host = url.host, LoopbackLink.isLoopbackHost(host) else { return nil }
        self.url = url
        self.port = url.port ?? (scheme == "https" ? 443 : 80)
    }

    /// The loopback address an OAuth sign-in page redirects to (its `redirect_uri`), or nil.
    static func redirect(of url: URL) -> LoopbackLink? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "redirect_uri" })?.value,
              let redirect = URL(string: raw) else { return nil }
        return LoopbackLink(redirect)
    }

    /// The same URL rewritten onto another local port (used when the remote's port is busy here).
    func rewritten(toLocalPort localPort: Int) -> URL {
        guard localPort != port, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.host = "127.0.0.1"
        components.port = localPort
        return components.url ?? url
    }
}

enum ForwardError: Error, CustomStringConvertible {
    /// The remote refused before the handshake: HTTP status, `X-DeepSea-Forward-Error` code, body text.
    case refused(status: Int, code: String, message: String)
    case transport(String)
    case listen(String)

    var description: String {
        switch self {
        case .refused(_, let code, let message):
            switch code {
            case "nothing-listening": return "Nothing is listening on that port on the server's machine (or it belongs to another account)."
            case "foreign-owner": return "That port is held by another account on the server's machine."
            case "reserved": return "That port is the DeepSea server itself — it is served by the remote, not forwarded."
            case "disabled": return "Loopback forwarding is turned off on this server (loopbackForward: off)."
            case "not-operator": return "Loopback forwarding on this server is reserved for its operators."
            case "connect-failed": return "The server could not connect to that port: \(message)"
            default: return message.isEmpty ? "The server refused the forward (\(code))." : message
            }
        case .transport(let text): return "Could not reach the server's machine: \(text)"
        case .listen(let text): return "Could not listen locally: \(text)"
        }
    }

    var refusalCode: String? {
        if case .refused(_, let code, _) = self { return code }
        return nil
    }
}

/// One TCP connection accepted locally ↔ one WebSocket to the remote's forward endpoint.
///
/// All state lives on `queue` (the NWConnection's queue; URLSession callbacks
/// hop onto it). Local→remote bytes go through one ordered outbound queue: the
/// browser speaks first (its HTTP request) and those bytes are held until the
/// remote's `connected` frame says the target accepted, then everything drains
/// in arrival order, one WebSocket message in flight at a time. Local reads
/// pause while more than `highWater` chunks wait, so a fast browser cannot
/// pile up memory behind a slow tunnel.
final class ForwardConnection: NSObject, URLSessionWebSocketDelegate {
    private let tcp: NWConnection
    private var ws: URLSessionWebSocketTask?
    private var session: URLSession?
    private let queue = DispatchQueue(label: "deepsea.forward.connection")
    private var closed = false
    private let onClose: (ForwardConnection) -> Void
    private var connected = false
    private var outbound: [Data] = []
    private var sending = false
    private var reading = false
    private let highWater = 32

    init(tcp: NWConnection, onClose: @escaping (ForwardConnection) -> Void) {
        self.tcp = tcp
        self.onClose = onClose
        super.init()
    }

    func start(request: URLRequest) {
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 32 * 1024 * 1024
        ws = task
        task.resume()
        receiveFromRemote()
        tcp.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: self.readFromLocal()
            case .failed, .cancelled: self.close(reason: "local side \(state)")
            default: break
            }
        }
        tcp.start(queue: queue)
    }

    // MARK: local → remote

    private func readFromLocal() {
        if reading || closed { return }
        reading = true
        tcp.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            self.reading = false
            if let data, !data.isEmpty {
                self.outbound.append(data)
                self.pumpOutbound()
                if self.outbound.count < self.highWater { self.readFromLocal() }
                return
            }
            if isComplete || error != nil { self.close(reason: "local side ended") }
        }
    }

    private func pumpOutbound() {
        if sending || !connected || closed || outbound.isEmpty { return }
        sending = true
        let chunk = outbound.removeFirst()
        ws?.send(.data(chunk)) { [weak self] error in
            guard let self else { return }
            self.queue.async {
                self.sending = false
                if error != nil { self.close(reason: "remote send failed"); return }
                self.pumpOutbound()
                if self.outbound.count < self.highWater { self.readFromLocal() }
            }
        }
    }

    // MARK: remote → local

    private func receiveFromRemote() {
        ws?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.close(reason: "remote receive failed: \(error.localizedDescription)")
            case .success(let message):
                switch message {
                case .data(let data):
                    self.tcp.send(content: data, completion: .contentProcessed { [weak self] error in
                        guard let self else { return }
                        if error != nil { self.close(reason: "local send failed"); return }
                        self.receiveFromRemote()
                    })
                case .string(let text):
                    // Control frames from forward.mjs: `connected` unlocks the local→remote direction.
                    if text.contains("\"connected\"") {
                        self.queue.async {
                            self.connected = true
                            self.pumpOutbound()
                        }
                    }
                    self.receiveFromRemote()
                @unknown default:
                    self.receiveFromRemote()
                }
            }
        }
    }

    // MARK: teardown

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        close(reason: "remote closed (\(closeCode.rawValue))")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        close(reason: error == nil ? "remote completed" : "remote failed: \(error!.localizedDescription)")
    }

    func close(reason: String) {
        queue.async {
            if self.closed { return }
            self.closed = true
            self.outbound.removeAll()
            self.ws?.cancel(with: .normalClosure, reason: nil)
            self.session?.finishTasksAndInvalidate()
            self.tcp.cancel()
            self.onClose(self)
        }
    }
}

/// A local listener on `127.0.0.1:<localPort>` forwarding to `<remotePort>` on the server's machine.
final class ForwardListener {
    let remotePort: Int
    let localPort: Int
    let since = Date()
    /// Closes itself once a connection has come and gone (a sign-in callback); see `finished`.
    let singleUse: Bool
    /// How long it may sit without a connection before it is closed.
    var idleLimit: TimeInterval { singleUse ? 10 * 60 : 60 * 60 }
    /// Called (on the main queue) when a single-use listener has served its connection.
    var finished: (() -> Void)?
    private(set) var connectionCount = 0
    private(set) var lastActivity = Date()
    private let listener: NWListener
    private var connections: [ObjectIdentifier: ForwardConnection] = [:]
    private var served = false
    private let queue: DispatchQueue
    private let request: () -> URLRequest?
    private let log: (String) -> Void

    init(remotePort: Int, preferredLocalPort: Int, singleUse: Bool = false, request: @escaping () -> URLRequest?, log: @escaping (String) -> Void) throws {
        self.remotePort = remotePort
        self.singleUse = singleUse
        self.request = request
        self.log = log
        // Loopback only: the listener must never be reachable from the LAN.
        // (`requiredLocalEndpoint` with a hostPort fails with EINVAL on
        // macOS 26's Network.framework; the interface-type form is the
        // supported spelling.)
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = false
        let made: NWListener
        do {
            made = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: UInt16(preferredLocalPort)) ?? .any)
        } catch {
            throw ForwardError.listen(error.localizedDescription)
        }
        // Bind synchronously so the caller learns the port (or the failure) before the navigation proceeds.
        let group = DispatchGroup()
        group.enter()
        var failure: Error?
        var bound = preferredLocalPort
        let bindQueue = DispatchQueue(label: "deepsea.forward.listener")
        // `start` fails with EINVAL unless a connection handler is installed first;
        // nobody can connect before the port is known, so a placeholder suffices.
        made.newConnectionHandler = { connection in connection.cancel() }
        made.stateUpdateHandler = { state in
            switch state {
            case .ready:
                bound = Int(made.port?.rawValue ?? UInt16(preferredLocalPort))
                group.leave()
            case .failed(let error):
                failure = error
                group.leave()
            default: break
            }
        }
        made.start(queue: bindQueue)
        if group.wait(timeout: .now() + 3) == .timedOut { made.cancel(); throw ForwardError.listen("timed out binding 127.0.0.1:\(preferredLocalPort)") }
        if let failure { made.cancel(); throw ForwardError.listen(failure.localizedDescription) }
        listener = made
        localPort = bound
        queue = bindQueue
        made.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        made.stateUpdateHandler = { [weak self] state in
            if case .failed(let error) = state { self?.log("forward: listener 127.0.0.1:\(bound) failed: \(error.localizedDescription)") }
        }
    }

    private func accept(_ connection: NWConnection) {
        guard let request = request() else { connection.cancel(); return }
        let forward = ForwardConnection(tcp: connection) { [weak self] done in
            guard let self else { return }
            self.queue.async {
                self.connections.removeValue(forKey: ObjectIdentifier(done))
                self.connectionCount = self.connections.count
                self.lastActivity = Date()
                // A single-use listener goes once its connection is done, after a moment for the
                // browser's follow-up requests (a favicon) on the same page.
                guard self.singleUse, !self.served else { return }
                self.served = true
                self.queue.asyncAfter(deadline: .now() + 2) {
                    if self.connections.isEmpty { DispatchQueue.main.async { self.finished?() } } else { self.served = false }
                }
            }
        }
        connections[ObjectIdentifier(forward)] = forward
        connectionCount = connections.count
        lastActivity = Date()
        forward.start(request: request)
    }

    func close() {
        listener.cancel()
        queue.async {
            for connection in self.connections.values { connection.close(reason: "listener closed") }
            self.connections.removeAll()
            self.connectionCount = 0
        }
    }
}

/// One forward: a port on the machine of the server at `base` (a mount directory).
struct ForwardKey: Hashable {
    let base: String
    let port: Int
}

/// The table of forwards and the probe that precedes each one.
final class PortForwarder: NSObject, URLSessionWebSocketDelegate {
    /// Mount base the page is currently loaded from (`https://node/deepsea/` or the loopback fallback), or nil while offline.
    var endpointBase: () -> URL?
    var log: (String) -> Void
    /// The page's cookie store (the window's: an `--ephemeral` test build keeps its own), set once the web view exists.
    var cookieStore: () -> WKHTTPCookieStore = { WKWebsiteDataStore.default().httpCookieStore }
    private(set) var listeners: [ForwardKey: ForwardListener] = [:]
    private var pending: [ForwardKey: [(Result<ForwardListener, ForwardError>) -> Void]] = [:]
    private var idleTimer: Timer?

    init(endpointBase: @escaping () -> URL?, log: @escaping (String) -> Void) {
        self.endpointBase = endpointBase
        self.log = log
        super.init()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.closeIdle() }
    }

    /// The forward endpoint for a remote port under a server's mount, as a WebSocket request carrying the page's cookies.
    private func forwardRequest(remotePort: Int, base: URL, cookies: [HTTPCookie]) -> URLRequest? {
        // `base` is the mount directory with its trailing slash, so the relative path lands under it.
        guard let endpoint = URL(string: "api/deepsea-tailscale/loopback-forward", relativeTo: base)?.absoluteURL,
              var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = base.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "port", value: String(remotePort))]
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("DeepSea/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")", forHTTPHeaderField: "User-Agent")
        let relevant = cookies.filter { cookie in
            let host = base.host?.lowercased() ?? ""
            let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return host == domain || host.hasSuffix(".\(domain)")
        }
        if !relevant.isEmpty {
            request.setValue(relevant.map { "\($0.name)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        }
        return request
    }

    /// Make `127.0.0.1:<remotePort>` of the machine of the server at `via` (default: the app's own) reachable
    /// here, on another local port when that one is taken here; the result names the listener.
    /// `exactPort` (a sign-in callback, whose redirect names the port): that port or nothing; it is bound
    /// before the server is asked, so a port taken here (the sign-in's own listener, when the server is on
    /// this Mac after all) fails at once with `.listen`. `singleUse`: closed once a connection has gone through.
    func ensure(remotePort: Int, via: URL? = nil, exactPort: Bool = false, singleUse: Bool = false,
                completion: @escaping (Result<ForwardListener, ForwardError>) -> Void) {
        guard let base = via ?? endpointBase() else { completion(.failure(.transport("the server's machine is not connected"))); return }
        let key = ForwardKey(base: base.absoluteString, port: remotePort)
        if let existing = listeners[key] { completion(.success(existing)); return }
        if pending[key] != nil { pending[key]!.append(completion); return }
        pending[key] = [completion]
        let settle: (Result<ForwardListener, ForwardError>) -> Void = { [weak self] result in
            guard let self else { return }
            let waiters = self.pending.removeValue(forKey: key) ?? []
            if case .success(let listener) = result {
                self.listeners[key] = listener
                listener.finished = { [weak self, weak listener] in
                    guard let self, let listener, self.listeners[key] === listener else { return }
                    self.close(key)
                }
            }
            for waiter in waiters { waiter(result) }
        }
        // Bound first for an exact port, so a port taken here costs no question to the server.
        var early: ForwardListener?
        var request: URLRequest?
        if exactPort {
            do {
                early = try ForwardListener(remotePort: remotePort, preferredLocalPort: remotePort, singleUse: singleUse, request: { request }, log: log)
            } catch let error as ForwardError {
                settle(.failure(error)); return
            } catch {
                settle(.failure(.listen(error.localizedDescription))); return
            }
        }
        cookieStore().getAllCookies { [weak self] cookies in
            guard let self else { early?.close(); return }
            guard let made = self.forwardRequest(remotePort: remotePort, base: base, cookies: cookies) else {
                early?.close()
                settle(.failure(.transport("the server's machine is not connected")))
                return
            }
            request = made
            self.probe(made) { [weak self] probeResult in
                guard let self else { early?.close(); return }
                DispatchQueue.main.async {
                    switch probeResult {
                    case .failure(let error):
                        early?.close()
                        self.log("forward: port \(remotePort) via \(base.absoluteString) refused: \(error)")
                        settle(.failure(error))
                    case .success:
                        if let early {
                            self.log("forward: 127.0.0.1:\(early.localPort) → \(remotePort) via \(base.absoluteString)\(singleUse ? " (single use)" : "")")
                            settle(.success(early))
                        } else {
                            settle(self.bind(remotePort: remotePort, request: made))
                        }
                    }
                }
            }
        }
    }

    /// Listen on the remote's port number here when it is free, else on any free port (the URL is rewritten then).
    /// Connections reuse the probe's request: identity admission needs no cookie, and the proxy cookie is long-lived.
    private func bind(remotePort: Int, request: URLRequest) -> Result<ForwardListener, ForwardError> {
        do {
            let listener = try ForwardListener(remotePort: remotePort, preferredLocalPort: remotePort, request: { request }, log: log)
            log("forward: 127.0.0.1:\(listener.localPort) → remote 127.0.0.1:\(remotePort)")
            return .success(listener)
        } catch {
            let why = (error as? ForwardError)?.description ?? error.localizedDescription
            do {
                let listener = try ForwardListener(remotePort: remotePort, preferredLocalPort: 0, request: { request }, log: log)
                log("forward: 127.0.0.1:\(listener.localPort) → remote 127.0.0.1:\(remotePort) (\(remotePort) is busy here: \(why))")
                return .success(listener)
            } catch let inner as ForwardError {
                return .failure(inner)
            } catch {
                return .failure(.listen(error.localizedDescription))
            }
        }
    }

    /// One handshake + the `connected` frame, then a clean close: the remote's verdict without any local state.
    private func probe(_ request: URLRequest, completion: @escaping (Result<Void, ForwardError>) -> Void) {
        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: request)
        var done = false
        let finish: (Result<Void, ForwardError>) -> Void = { result in
            if done { return }
            done = true
            task.cancel(with: .normalClosure, reason: nil)
            session.finishTasksAndInvalidate()
            completion(result)
        }
        task.resume()
        task.receive { result in
            switch result {
            case .success(let message):
                if case .string(let text) = message, text.contains("\"connected\"") { finish(.success(())); return }
                finish(.failure(.transport("unexpected first frame from the forward endpoint")))
            case .failure(let error):
                if let response = task.response as? HTTPURLResponse {
                    let code = response.value(forHTTPHeaderField: "X-DeepSea-Forward-Error") ?? "http-\(response.statusCode)"
                    finish(.failure(.refused(status: response.statusCode, code: code, message: PortForwarder.refusalMessage(response: response, fallback: error.localizedDescription))))
                } else {
                    finish(.failure(.transport(error.localizedDescription)))
                }
            }
        }
    }

    /// forward.mjs puts the human text in the body, which a WebSocket task does not surface; the header carries the code, the status the class.
    private static func refusalMessage(response: HTTPURLResponse, fallback: String) -> String {
        switch response.statusCode {
        case 401: return "not signed in to the server's machine"
        case 403: return "refused by the server's machine"
        case 404: return "nothing listening on the server's machine"
        case 502: return "the server's machine could not connect to the port"
        case 503: return "the server's machine cannot forward right now"
        default: return fallback
        }
    }

    private func close(_ key: ForwardKey) {
        guard let listener = listeners.removeValue(forKey: key) else { return }
        listener.close()
        log("forward: closed 127.0.0.1:\(listener.localPort) → remote \(key.port) via \(key.base)")
    }

    /// Close every forward of a remote port (the menu's Close).
    func close(remotePort: Int) {
        for key in listeners.keys where key.port == remotePort { close(key) }
    }

    func closeAll() {
        for key in Array(listeners.keys) { close(key) }
    }

    private func closeIdle() {
        let now = Date()
        for (key, listener) in listeners where listener.connectionCount == 0 && now.timeIntervalSince(listener.lastActivity) > listener.idleLimit {
            close(key)
        }
    }

    /// Rows for the View ▸ Forwarded Ports menu.
    var rows: [(remotePort: Int, localPort: Int, connections: Int)] {
        listeners.values.sorted { $0.remotePort < $1.remotePort }.map { ($0.remotePort, $0.localPort, $0.connectionCount) }
    }
}
