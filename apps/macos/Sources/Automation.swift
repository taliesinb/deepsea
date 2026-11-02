// The automation channel: a test build started with `--automation <socket>`
// accepts requests on that Unix socket (mode 0600), one JSON object per line,
// and answers each with one line:
//
//   → {"id": 1, "op": "eval", "js": "return document.title"}
//   ← {"id": 1, "ok": true, "value": "DSH Local Build"}
//   ← {"id": 2, "ok": false, "error": {"code": "page-error", "message": "…"}}
//
// Operations (arguments beside `op`):
//   hello                                   pid, bundle id, variant, version, url, loaded, hidden, ephemeral, log
//   load {url, timeoutMs?}                  navigate; answers when the page has loaded, or with
//                                           `download` when the response is saved as a download; the
//                                           URL may be outside the app's server, and so may its
//                                           redirects on the same origin until it has loaded
//   reload {timeoutMs?}                     reload; the same
//   wait-page {selector? | text? | expression?, timeoutMs?, settleMs?}
//                                           until a selector matches, the page text contains `text`, or the
//                                           function body `expression` returns something truthy (its JSON value)
//   eval {js}                               run a function body in the page (await allowed); its JSON value
//   resize {width, height}                  content size in points, top-left kept
//   view {mode: desktop | mobile}           View ▸ Desktop / Mobile
//   appearance {value: light | dark | system}
//   click {selector, nth? | text, selector? , nth? | x, y; clicks?}
//                                           real mouse events at the element's centre (scrolled into view; with
//                                           `text`, the innermost element showing exactly that text, else containing
//                                           it, within `selector`) or at a viewport point (CSS px)
//   type {text? , key?}                     real key events: `text` character by character, `key` one named key
//                                           with modifiers (`Enter`, `Escape`, `cmd+k`, `shift+Tab`)
//   describe {selector, nth? | target; options?}   the element inspector's record
//   snapshot {selector, nth? | target; options?}   an element snapshot (files, image hashes)
//   snapshot {window: true, chrome?}        the page, or with `chrome` the whole window (a visible app only)
//   window-info                             frame, screen, key/active, content size, view mode, appearance
//   log {lines?}                            the last lines of this run's log
//   opened {clear?}                         URLs the app opened, or would have, outside itself (a
//                                           hidden test build never opens them: links, sign-in
//                                           pages, Preview)
//   quit                                    answer, then quit
//
// Page operations fail with `offline` while the offline page shows. One request
// runs at a time per connection; responses come in request order.

import Cocoa
import WebKit

final class Automation {
    static let protocolVersion = 1

    let path: String
    private weak var app: AppDelegate?
    private let listenFD: Int32
    private let listenSource: DispatchSourceRead
    private var clients: [Int32: Client] = [:]
    /// Pending `load` / `reload` requests, answered by the next main-frame navigation's end:
    /// a failure message, or the facts of a navigation that became a download.
    private var navigationWaiters: [(String?, [String: Any]?) -> Void] = []

    struct Failure: Error { let code: String; let message: String }

    private final class Client {
        let fd: Int32
        let source: DispatchSourceRead
        var buffer = Data()
        var queue: [[String: Any]] = []
        var busy = false
        init(fd: Int32, source: DispatchSourceRead) { self.fd = fd; self.source = source }
    }

    init(path: String, app: AppDelegate) throws {
        self.path = path
        self.app = app
        var addr = sockaddr_un()
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard path.utf8.count < capacity else { throw Failure(code: "path", message: "socket path longer than \(capacity - 1) bytes") }
        unlink(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure(code: "socket", message: String(cString: strerror(errno))) }
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            let bytes = Array(path.utf8)
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let old = umask(0o077)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        umask(old)
        guard bound == 0, listen(fd, 4) == 0 else {
            let message = String(cString: strerror(errno))
            close(fd)
            throw Failure(code: "bind", message: message)
        }
        chmod(path, 0o600)
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        listenFD = fd
        listenSource = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        listenSource.setEventHandler { [weak self] in self?.acceptClients() }
        listenSource.resume()
    }

    func stop() {
        listenSource.cancel()
        close(listenFD)
        for client in clients.values { client.source.cancel(); close(client.fd) }
        clients.removeAll()
        unlink(path)
    }

    // MARK: navigation hooks (called by the AppDelegate)

    func navigationFinished() { resolveNavigation(nil) }
    func navigationFailed(_ message: String) { resolveNavigation(message) }
    /// The navigation turned into a download: a `load` answers with where it is saved.
    func navigationDownloaded(_ url: String) { resolveNavigation(nil, ["download": url]) }

    private func resolveNavigation(_ failure: String?, _ facts: [String: Any]? = nil) {
        let waiters = navigationWaiters
        navigationWaiters.removeAll()
        for waiter in waiters { waiter(failure, facts) }
    }

    // MARK: connections

    private func acceptClients() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { return }
            var on: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            // BSD hands the listener's O_NONBLOCK to accepted sockets; replies are written whole,
            // so this one blocks (reads only happen when the source reports data).
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
            let client = Client(fd: fd, source: source)
            source.setEventHandler { [weak self, weak client] in
                guard let self, let client else { return }
                self.read(client)
            }
            clients[fd] = client
            source.resume()
        }
    }

    private func read(_ client: Client) {
        var chunk = [UInt8](repeating: 0, count: 65536)
        let count = Darwin.read(client.fd, &chunk, chunk.count)
        if count <= 0 {
            client.source.cancel()
            close(client.fd)
            clients[client.fd] = nil
            return
        }
        client.buffer.append(contentsOf: chunk[0..<count])
        while let newline = client.buffer.firstIndex(of: 0x0a) {
            let line = client.buffer[client.buffer.startIndex..<newline]
            client.buffer.removeSubrange(client.buffer.startIndex...newline)
            if line.allSatisfy({ $0 == 0x20 || $0 == 0x0d }) { continue }
            guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                send(client, id: NSNull(), result: .failure(Failure(code: "bad-request", message: "each line must be a JSON object")))
                continue
            }
            client.queue.append(request)
        }
        runNext(client)
    }

    private func runNext(_ client: Client) {
        guard !client.busy, !client.queue.isEmpty else { return }
        client.busy = true
        let request = client.queue.removeFirst()
        let id = request["id"] ?? NSNull()
        perform(request) { [weak self, weak client] result in
            guard let self, let client else { return }
            self.send(client, id: id, result: result)
            client.busy = false
            self.runNext(client)
        }
    }

    /// A value already encoded as JSON text, passed through verbatim.
    struct RawJSON { let text: String }

    private func send(_ client: Client, id: Any, result: Result<Any, Failure>) {
        let idText = json(id) ?? "null"
        var line: String
        switch result {
        case .success(let value):
            let valueText = (value as? RawJSON)?.text ?? json(value) ?? "null"
            line = "{\"id\":\(idText),\"ok\":true,\"value\":\(valueText)}"
        case .failure(let failure):
            let error = json(["code": failure.code, "message": failure.message]) ?? "{}"
            line = "{\"id\":\(idText),\"ok\":false,\"error\":\(error)}"
        }
        line += "\n"
        let data = Array(line.utf8)
        let total = data.count
        var offset = 0
        while offset < total {
            let written = data.withUnsafeBytes { Darwin.write(client.fd, $0.baseAddress! + offset, total - offset) }
            if written < 0, errno == EINTR { continue }
            if written <= 0 { return }
            offset += written
        }
    }

    private func json(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: operations

    private typealias Done = (Result<Any, Failure>) -> Void

    private func perform(_ request: [String: Any], done: @escaping Done) {
        guard let app else { done(.failure(Failure(code: "gone", message: "the app is shutting down"))); return }
        let op = request["op"] as? String ?? ""
        let pageOps: Set<String> = ["wait-page", "eval", "click", "type", "describe"]
        if pageOps.contains(op) || (op == "snapshot" && request["window"] as? Bool != true), app.showingOfflinePage {
            done(.failure(Failure(code: "offline", message: "the offline page is showing")))
            return
        }
        switch op {
        case "hello": done(.success(hello(app)))
        case "load": load(app, request, done)
        case "reload": reload(app, request, done)
        case "wait-page": waitPage(app, request, done)
        case "eval": evaluate(app, request, done)
        case "resize": resize(app, request, done)
        case "view": view(app, request, done)
        case "appearance": appearance(app, request, done)
        case "click": click(app, request, done)
        case "type": type(app, request, done)
        case "describe": describe(app, request, done)
        case "snapshot": snapshot(app, request, done)
        case "window-info": done(.success(windowInfo(app)))
        case "log": done(.success(logTail(app, request)))
        case "opened":
            let urls = app.externalOpens
            if request["clear"] as? Bool == true { app.externalOpens.removeAll() }
            done(.success(["urls": urls]))
        case "quit":
            done(.success(["quitting": true]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
        default:
            done(.failure(Failure(code: "unknown-op", message: "unknown op \"\(op)\"")))
        }
    }

    private func hello(_ app: AppDelegate) -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "protocol": Self.protocolVersion,
            "pid": Int(getpid()),
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "variant": AppPaths.variantName,
            "name": app.config.name,
            "version": info["CFBundleShortVersionString"] ?? NSNull(),
            "build": info["CFBundleVersion"] ?? NSNull(),
            "url": app.webView.url?.absoluteString ?? NSNull(),
            "loaded": app.pageLoaded && !app.showingOfflinePage,
            "offline": app.showingOfflinePage,
            "hidden": app.options.hidden,
            "ephemeral": app.options.ephemeral,
            "log": app.logURL.path,
        ]
    }

    private func timeout(_ request: [String: Any], _ fallback: Double) -> Double {
        ((request["timeoutMs"] as? NSNumber)?.doubleValue ?? fallback) / 1000
    }

    /// Answer `done` at the end of the next main-frame navigation, or after the timeout.
    private func awaitNavigation(_ seconds: Double, _ app: AppDelegate, _ done: @escaping Done) {
        var settled = false
        let finish: (String?, [String: Any]?) -> Void = { [weak app] failure, facts in
            guard !settled else { return }
            settled = true
            if let failure { done(.failure(Failure(code: "navigation", message: failure))) }
            else { done(.success(facts ?? ["url": (app?.webView.url?.absoluteString as Any?) ?? NSNull()])) }
        }
        navigationWaiters.append(finish)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { finish("no page load within \(Int(seconds)) s", nil) }
    }

    private func load(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        guard let raw = request["url"] as? String, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            done(.failure(Failure(code: "bad-request", message: "\"url\" must be an http(s) URL")))
            return
        }
        awaitNavigation(timeout(request, 30_000), app, done)
        app.showingOfflinePage = false
        app.automationLoad = url
        app.webView.load(URLRequest(url: url))
    }

    private func reload(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        awaitNavigation(timeout(request, 30_000), app, done)
        if app.showingOfflinePage { app.connect() } else { app.webView.reloadFromOrigin() }
    }

    /// Run a function body in the page; its value comes back as JSON text.
    func evaluateJSON(_ app: AppDelegate, body: String, arguments: [String: Any] = [:], completion: @escaping (Result<String, Failure>) -> Void) {
        let wrapped = "const __deepsea_value = await (async () => {\n\(body)\n})();\nconst __deepsea_json = JSON.stringify(__deepsea_value === undefined ? null : __deepsea_value);\nreturn __deepsea_json === undefined ? 'null' : __deepsea_json"
        app.webView.callAsyncJavaScript(wrapped, arguments: arguments, in: nil, in: .page) { result in
            switch result {
            case .success(let value): completion(.success(value as? String ?? "null"))
            case .failure(let error):
                let ns = error as NSError
                let message = ns.userInfo["WKJavaScriptExceptionMessage"] as? String ?? ns.localizedDescription
                completion(.failure(Failure(code: "page-error", message: message)))
            }
        }
    }

    private func evaluate(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        guard let js = request["js"] as? String else { done(.failure(Failure(code: "bad-request", message: "\"js\" (a function body) is required"))); return }
        evaluateJSON(app, body: js) { result in
            switch result {
            case .success(let text): done(.success(RawJSON(text: text)))
            case .failure(let failure): done(.failure(failure))
            }
        }
    }

    private func waitPage(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        let selector = request["selector"] as? String
        let text = request["text"] as? String
        let expression = request["expression"] as? String
        guard selector != nil || text != nil || expression != nil else {
            done(.failure(Failure(code: "bad-request", message: "wait-page needs \"selector\", \"text\" or \"expression\"")))
            return
        }
        let deadline = Date().addingTimeInterval(timeout(request, 15_000))
        let settle = ((request["settleMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
        let started = Date()
        let check = expression ?? """
            if (selector != null && document.querySelector(selector)) return { matched: 'selector' };
            if (text != null && document.body && document.body.innerText.includes(text)) return { matched: 'text' };
            return null;
            """
        let arguments: [String: Any] = expression == nil ? ["selector": (selector as Any?) ?? NSNull(), "text": (text as Any?) ?? NSNull()] : [:]
        func poll() {
            evaluateJSON(app, body: check, arguments: arguments) { result in
                if case .success(let value) = result, !["null", "false", "0", "\"\"", "undefined"].contains(value) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
                        let waited = Int(Date().timeIntervalSince(started) * 1000)
                        done(.success(RawJSON(text: "{\"waitedMs\":\(waited),\"value\":\(value)}")))
                    }
                    return
                }
                if Date() >= deadline {
                    let failure: String
                    if case .failure(let error) = result { failure = ": \(error.message)" } else { failure = "" }
                    done(.failure(Failure(code: "timeout", message: "not matched within \(Int(Date().timeIntervalSince(started) * 1000)) ms\(failure)")))
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { poll() }
            }
        }
        poll()
    }

    private func contentSize(_ app: AppDelegate) -> [String: Any] {
        ["width": app.webView.bounds.width, "height": app.webView.bounds.height]
    }

    private func resize(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        guard let w = (request["width"] as? NSNumber)?.doubleValue, let h = (request["height"] as? NSNumber)?.doubleValue, w >= 300, h >= 200 else {
            done(.failure(Failure(code: "bad-request", message: "\"width\" ≥ 300 and \"height\" ≥ 200 (points) are required")))
            return
        }
        app.resizeContentKeepingTopLeft(to: NSSize(width: w, height: h), animate: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { done(.success(["contentSize": self.contentSize(app)])) }
    }

    private func view(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        guard let mode = (request["mode"] as? String).flatMap(ViewMode.init(rawValue:)) else {
            done(.failure(Failure(code: "bad-request", message: "\"mode\" is desktop or mobile")))
            return
        }
        app.setViewMode(mode, animate: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { done(.success(["mode": mode.rawValue, "contentSize": self.contentSize(app)])) }
    }

    private func appearance(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        switch request["value"] as? String {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        case "system": NSApp.appearance = nil
        default: done(.failure(Failure(code: "bad-request", message: "\"value\" is light, dark or system"))); return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            done(.success(["appearance": app.window.effectiveAppearance.name.rawValue]))
        }
    }

    /// The target an op names: `target` as given, `{selector, nth}`, or `{x, y}`.
    private func target(_ request: [String: Any]) -> Any? {
        if let target = request["target"] { return target }
        if let selector = request["selector"] as? String { return ["selector": selector, "nth": (request["nth"] as? NSNumber)?.intValue ?? 0] }
        if let x = request["x"] as? NSNumber, let y = request["y"] as? NSNumber { return ["x": x, "y": y] }
        return nil
    }

    // MARK: input events

    private func click(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        let clicks = max(1, (request["clicks"] as? NSNumber)?.intValue ?? 1)
        let locate: (@escaping (Result<(CGFloat, CGFloat, String), Failure>) -> Void) -> Void = { found in
            if request["selector"] is String || request["text"] is String {
                let body = """
                    let all, what;
                    if (text != null) {
                      const shown = e => (e.innerText || '').trim();
                      const roots = selector ? [...document.querySelectorAll(selector)] : [document.body];
                      const scope = [...new Set(roots.flatMap(r => [...(selector ? [r] : []), ...r.querySelectorAll('*')]))].filter(e => e.getClientRects().length > 0);
                      let pool = scope.filter(e => shown(e) === text);
                      if (pool.length === 0) pool = scope.filter(e => shown(e).includes(text));
                      all = pool.filter(e => !pool.some(o => o !== e && e.contains(o)));
                      what = 'text ' + JSON.stringify(text) + (selector ? ' within ' + selector : '');
                    } else {
                      all = [...document.querySelectorAll(selector)];
                      what = selector;
                    }
                    const el = all[nth < 0 ? all.length + nth : nth];
                    if (!el) return { error: 'nothing matches ' + what + (all.length ? ' at index ' + nth + ' (' + all.length + ' matches)' : '') };
                    // Scroll only when needed, and only as far as needed: `center` would also scroll
                    // overflow-hidden ancestors and shift the whole app shell.
                    let r = el.getBoundingClientRect();
                    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); r = el.getBoundingClientRect() }
                    if (r.width === 0 && r.height === 0) return { error: 'the element has no size (hidden?)' };
                    const x = r.left + r.width / 2, y = r.top + r.height / 2;
                    const hit = document.elementFromPoint(x, y);
                    const label = e => e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : 'nothing';
                    return { x, y, hit: hit === el || el.contains(hit) ? label(el) : label(hit) + ' (covering ' + label(el) + ')' };
                    """
                let arguments: [String: Any] = ["selector": (request["selector"] as? String as Any?) ?? NSNull(), "text": (request["text"] as? String as Any?) ?? NSNull(), "nth": (request["nth"] as? NSNumber)?.intValue ?? 0]
                self.evaluateJSON(app, body: body, arguments: arguments) { result in
                    switch result {
                    case .failure(let failure): found(.failure(failure))
                    case .success(let text):
                        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { found(.failure(Failure(code: "page-error", message: text))); return }
                        if let error = object["error"] as? String { found(.failure(Failure(code: "not-found", message: error))); return }
                        found(.success((CGFloat((object["x"] as? NSNumber)?.doubleValue ?? 0), CGFloat((object["y"] as? NSNumber)?.doubleValue ?? 0), object["hit"] as? String ?? "")))
                    }
                }
            } else if let x = request["x"] as? NSNumber, let y = request["y"] as? NSNumber {
                found(.success((CGFloat(x.doubleValue), CGFloat(y.doubleValue), "")))
            } else {
                found(.failure(Failure(code: "bad-request", message: "click needs \"selector\", \"text\", or \"x\" and \"y\"")))
            }
        }
        locate { result in
            switch result {
            case .failure(let failure): done(.failure(failure))
            case .success(let (x, y, hit)):
                // CSS px → web view points (page zoom) → window coordinates.
                let zoom = app.webView.pageZoom
                let inView = NSPoint(x: x * zoom, y: app.webView.isFlipped ? y * zoom : app.webView.bounds.height - y * zoom)
                let location = app.webView.convert(inView, to: nil)
                let window = app.window!
                var steps: [() -> Void] = []
                let event = { (type: NSEvent.EventType, count: Int) -> () -> Void in
                    {
                        guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                             windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: type == .leftMouseDown ? 1 : 0) else { return }
                        // Straight to the web view: the window's own routing drops mouse events while it
                        // ignores them (a hidden window is click-through for the person at the screen).
                        switch type {
                        case .leftMouseDown: app.webView.mouseDown(with: event)
                        case .leftMouseUp: app.webView.mouseUp(with: event)
                        default: app.webView.mouseMoved(with: event)
                        }
                    }
                }
                steps.append(event(.mouseMoved, 0))
                for n in 1...clicks {
                    steps.append(event(.leftMouseDown, n))
                    steps.append(event(.leftMouseUp, n))
                }
                self.sequence(app, steps) { done(.success(["x": x, "y": y, "clicks": clicks, "hit": hit])) }
            }
        }
    }

    /// Named keys: macOS key code and the characters AppKit reports.
    private static let namedKeys: [String: (UInt16, String)] = [
        "enter": (36, "\r"), "return": (36, "\r"), "tab": (48, "\t"), "escape": (53, "\u{1b}"), "esc": (53, "\u{1b}"),
        "backspace": (51, "\u{7f}"), "delete": (117, String(UnicodeScalar(NSDeleteFunctionKey)!)), "space": (49, " "),
        "arrowleft": (123, String(UnicodeScalar(NSLeftArrowFunctionKey)!)), "arrowright": (124, String(UnicodeScalar(NSRightArrowFunctionKey)!)),
        "arrowdown": (125, String(UnicodeScalar(NSDownArrowFunctionKey)!)), "arrowup": (126, String(UnicodeScalar(NSUpArrowFunctionKey)!)),
        "home": (115, String(UnicodeScalar(NSHomeFunctionKey)!)), "end": (119, String(UnicodeScalar(NSEndFunctionKey)!)),
        "pageup": (116, String(UnicodeScalar(NSPageUpFunctionKey)!)), "pagedown": (121, String(UnicodeScalar(NSPageDownFunctionKey)!)),
    ]
    /// ANSI key codes of printable keys, so the page sees the right `KeyboardEvent.code`.
    private static let printableKeys: [Character: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
    ]

    /// Run `steps` one at a time, each after the page has handled the previous one: WebKit queues
    /// input events and sends the next only when the last is acknowledged, so a script round trip
    /// after each event (the page process handles messages in order) means it has been handled.
    private func sequence(_ app: AppDelegate, _ steps: [() -> Void], then finish: @escaping () -> Void) {
        var rest = steps[...]
        func next() {
            guard let step = rest.popFirst() else { finish(); return }
            step()
            app.webView.evaluateJavaScript("0") { _, _ in next() }
        }
        next()
    }

    /// Who would handle a menu action if the window were key: the responder chain from its first
    /// responder (the web view for ⌘A, ⌘C, ⌘V, ⌘Z), then the window and its delegate.
    private func actionTarget(_ action: Selector, in window: NSWindow) -> AnyObject? {
        var responder: NSResponder? = window.firstResponder
        while let current = responder {
            if current.responds(to: action) { return current }
            responder = current.nextResponder
        }
        for candidate in [window, window.delegate as AnyObject?] {
            if let object = candidate as? NSObject, object.responds(to: action) { return object }
        }
        return nil
    }

    /// The main-menu item a chord triggers (`a` + ⌘ → Edit ▸ Select All), searched depth first.
    private func menuItem(for characters: String, modifiers: NSEvent.ModifierFlags, in menu: NSMenu? = NSApp.mainMenu) -> NSMenuItem? {
        let wanted = modifiers.intersection([.command, .shift, .option, .control])
        for item in menu?.items ?? [] {
            if let found = menuItem(for: characters, modifiers: modifiers, in: item.submenu) { return found }
            if !item.keyEquivalent.isEmpty, item.keyEquivalent.lowercased() == characters.lowercased(),
               item.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control]) == wanted { return item }
        }
        return nil
    }

    /// The key-down and key-up of one key, as steps for `sequence`.
    ///
    /// A command chord goes to the page first (its `keydown` listeners see it and may claim it).
    /// One the page leaves alone (⌘A, ⌘C, ⌘V, ⌘Z) WebKit hands back to AppKit for the Edit menu,
    /// which reaches only the key window of the active app; a hidden test window is neither. So
    /// then the channel runs the menu item's command on the web view itself, as AppKit would.
    private func keySteps(_ app: AppDelegate, characters: String, keyCode: UInt16, modifiers: NSEvent.ModifierFlags) -> [() -> Void] {
        let window = app.window!
        let event = { (type: NSEvent.EventType) in
            NSEvent.keyEvent(with: type, location: .zero, modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                             windowNumber: window.windowNumber, context: nil, characters: characters,
                             charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode)
        }
        let keyUp: () -> Void = { if let up = event(.keyUp) { window.sendEvent(up) } }
        guard modifiers.contains(.command) else {
            return [{ if let down = event(.keyDown) { window.sendEvent(down) } }, keyUp]
        }
        return [
            // Note whether the page claims the chord: a once-only listener on window, which bubbles last.
            { app.webView.evaluateJavaScript("globalThis.__deepseaChord = 'unseen'; addEventListener('keydown', e => { globalThis.__deepseaChord = e.defaultPrevented ? 'claimed' : 'left' }, { once: true }); 0", completionHandler: nil) },
            { if let down = event(.keyDown), !app.webView.performKeyEquivalent(with: down) { window.sendEvent(down) } },
            {
                // AppKit handles the chord itself when it resolves the action without our window
                // (application-level items such as Settings…); only window-level ones need us.
                guard !(NSApp.isActive && window.isKeyWindow), let item = self.menuItem(for: characters, modifiers: modifiers), let action = item.action,
                      item.target == nil, NSApp.target(forAction: action, to: nil, from: item) == nil else { return }
                app.webView.evaluateJavaScript("globalThis.__deepseaChord") { value, _ in
                    if value as? String == "left", let target = self.actionTarget(action, in: window) {
                        NSApp.sendAction(action, to: target, from: item)
                    }
                }
            },
            keyUp,
        ]
    }

    private func type(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        let text = request["text"] as? String
        let key = request["key"] as? String
        guard (text == nil) != (key == nil) else { done(.failure(Failure(code: "bad-request", message: "type needs \"text\" or \"key\" (one of them)"))); return }
        app.window.makeFirstResponder(app.webView)
        var steps: [() -> Void] = []
        if let key {
            var parts = key.split(separator: "+").map { String($0) }
            let name = parts.popLast() ?? ""
            var modifiers: NSEvent.ModifierFlags = []
            for part in parts {
                switch part.lowercased() {
                case "cmd", "command", "meta": modifiers.insert(.command)
                case "shift": modifiers.insert(.shift)
                case "alt", "option", "opt": modifiers.insert(.option)
                case "ctrl", "control": modifiers.insert(.control)
                default: done(.failure(Failure(code: "bad-request", message: "unknown modifier \"\(part)\""))); return
                }
            }
            if let (code, characters) = Self.namedKeys[name.lowercased()] {
                steps = keySteps(app, characters: characters, keyCode: code, modifiers: modifiers)
            } else if name.count == 1, let c = name.lowercased().first {
                steps = keySteps(app, characters: modifiers.contains(.shift) ? name.uppercased() : name.lowercased(), keyCode: Self.printableKeys[c] ?? 0, modifiers: modifiers)
            } else {
                done(.failure(Failure(code: "bad-request", message: "unknown key \"\(name)\"")))
                return
            }
        } else if let text {
            for character in text {
                if character == "\n" { steps += keySteps(app, characters: "\r", keyCode: 36, modifiers: []); continue }
                let lower = Character(character.lowercased())
                steps += keySteps(app, characters: String(character), keyCode: Self.printableKeys[lower] ?? 0, modifiers: character.isUppercase ? [.shift] : [])
            }
        }
        sequence(app, steps) { done(.success(["typed": text ?? key ?? ""])) }
    }

    // MARK: inspector and snapshots

    private func describe(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        guard let target = target(request) else { done(.failure(Failure(code: "bad-request", message: "describe needs \"selector\", \"target\" or \"x\" and \"y\""))); return }
        app.describeElement(target: target, options: request["options"] as? [String: Any] ?? [:]) { record, _, failure in
            if let record { done(.success(record)) } else { done(.failure(Failure(code: "inspector", message: failure ?? "failed"))) }
        }
    }

    /// Finish running CSS animations and transitions before a capture. WebKit pauses them while the
    /// window is covered (the screen locked, another space), which would freeze the page mid-fade.
    private func settleAnimations(_ app: AppDelegate, then next: @escaping () -> Void) {
        evaluateJSON(app, body: "for (const a of document.getAnimations()) { try { if (a.effect && a.effect.getComputedTiming().endTime !== Infinity) a.finish() } catch {} } return null") { _ in next() }
    }

    private func snapshot(_ app: AppDelegate, _ request: [String: Any], _ done: @escaping Done) {
        if !app.showingOfflinePage, request["settled"] as? Bool != true {
            var next = request
            next["settled"] = true
            settleAnimations(app) { self.snapshot(app, next, done) }
            return
        }
        if request["window"] as? Bool == true {
            if request["chrome"] as? Bool == true {
                guard !app.options.hidden else { done(.failure(Failure(code: "hidden", message: "a hidden window has no visible chrome; take the page (without \"chrome\")"))); return }
                guard let png = app.windowSnapshotPNG(), let result = app.storeWindowSnapshot(png, open: false) else {
                    done(.failure(Failure(code: "capture", message: "window capture failed"))); return
                }
                done(.success(result))
                return
            }
            app.webViewPNG(rect: nil) { png, _ in
                guard let png, let result = app.storeWindowSnapshot(png, open: false) else { done(.failure(Failure(code: "capture", message: "page capture failed"))); return }
                done(.success(result))
            }
            return
        }
        guard let target = target(request) else { done(.failure(Failure(code: "bad-request", message: "snapshot needs \"selector\", \"target\", \"x\" and \"y\", or \"window\": true"))); return }
        app.describeElement(target: target, options: request["options"] as? [String: Any] ?? [:]) { record, inspector, failure in
            guard let record else { done(.failure(Failure(code: "inspector", message: failure ?? "failed"))); return }
            guard (record["inspector"] as? [String: Any])?["found"] as? Bool == true else {
                done(.failure(Failure(code: "not-found", message: "no element matches the target")))
                return
            }
            app.captureElementSnapshot(record: record, inspector: inspector, open: false) { saved in
                guard let saved else { done(.failure(Failure(code: "capture", message: "could not write the snapshot"))); return }
                done(.success([
                    "files": saved["files"] ?? NSNull(),
                    "images": saved["images"] ?? NSNull(),
                    "selector": ((saved["element"] as? [String: Any])?["selector"] as? [String: Any])?["unique"] ?? NSNull(),
                    "rect": ((saved["element"] as? [String: Any])?["rect"]) ?? NSNull(),
                ]))
            }
        }
    }

    private func windowInfo(_ app: AppDelegate) -> [String: Any] {
        var info = app.windowInfoDictionary()
        info["contentSize"] = contentSize(app)
        info["viewMode"] = app.viewMode.rawValue
        info["appearance"] = app.window.effectiveAppearance.name.rawValue
        info["pageZoom"] = app.webView.pageZoom
        info["hidden"] = app.options.hidden
        info["url"] = app.webView.url?.absoluteString ?? NSNull()
        return info
    }

    private func logTail(_ app: AppDelegate, _ request: [String: Any]) -> [String: Any] {
        let count = max(1, (request["lines"] as? NSNumber)?.intValue ?? 50)
        let text = (try? String(contentsOf: app.logURL, encoding: .utf8)) ?? ""
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).suffix(count + 1).joined(separator: "\n")
        return ["file": app.logURL.path, "text": lines]
    }
}
