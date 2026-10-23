// SignIn — "Sign in to GitHub" for the updater's private release feeds (Updater.swift).
//
// Preferred: the OAuth web application flow with PKCE and a LOOPBACK redirect
// (RFC 8252): the browser opens github.com/login/oauth/authorize, the user
// clicks Authorize, GitHub redirects to http://127.0.0.1:<port>/deepsea-updates/callback
// — a tiny listener this app runs for the duration — the code is exchanged
// for a user token and the app comes to the front. The port is fixed because
// GitHub matches callback URLs exactly (no port wildcard); the registered
// callback is `http://127.0.0.1:47831/deepsea-updates/callback`. The exchange
// needs the GitHub App's client secret (required even with PKCE), which the
// build bakes in: with the callback pinned to loopback and PKCE on, the secret
// alone lets nobody obtain anyone's code, so this is the accepted native-app
// shape (GitHub Desktop ships its secret the same way).
//
// Fallback, when no secret is baked or the port is busy: the device flow
// (RFC 8628) — a code to enter at github.com/login/device, polled for on a
// background thread.
//
// Everything is a SHEET on the main window, never an application-modal alert:
// the page keeps rendering and the user can keep working while GitHub is open.
import Cocoa
import CryptoKit
import Network

final class GitHubSignIn {
    static let callbackPort: UInt16 = 47831
    static let callbackPath = "/deepsea-updates/callback"
    static var callbackURL: String { "http://127.0.0.1:\(callbackPort)\(callbackPath)" }

    private let clientId: String
    private let clientSecret: String?
    private let oauthBase: String
    private let appName: String
    private let log: (String) -> Void
    private let userAgent: String

    private var listener: NWListener?
    private var sheet: NSPanel?
    private var finished = false
    private var completion: ((String?) -> Void)?

    init(clientId: String, clientSecret: String?, oauthBase: String, appName: String, userAgent: String, log: @escaping (String) -> Void) {
        self.clientId = clientId; self.clientSecret = clientSecret; self.oauthBase = oauthBase
        self.appName = appName; self.userAgent = userAgent; self.log = log
    }

    // MARK: entry

    /// Run the sign-in attached to `window`; `completion(token)` on the main thread, `nil` when cancelled or failed.
    func start(on window: NSWindow?, completion: @escaping (String?) -> Void) {
        self.completion = completion
        if clientSecret != nil, startLoopbackListener() {
            presentWaitingSheet(on: window, hint: "Authorize in the browser")
            openAuthorizePage()
        } else {
            if clientSecret != nil { log("update: sign-in: loopback port \(GitHubSignIn.callbackPort) unavailable; using the device flow") }
            startDeviceFlow(on: window)
        }
    }

    private func finish(_ token: String?) {
        guard !finished else { return }
        finished = true
        listener?.cancel(); listener = nil
        if let sheet, let parent = sheet.sheetParent { parent.endSheet(sheet) } else { sheet?.orderOut(nil) }
        sheet = nil
        completion?(token); completion = nil
    }

    // MARK: web application flow (PKCE + loopback)

    private var state = ""
    private var verifier = ""

    private func openAuthorizePage() {
        state = GitHubSignIn.random(32)
        verifier = GitHubSignIn.random(64)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        var c = URLComponents(string: oauthBase + "/login/oauth/authorize")!
        c.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: GitHubSignIn.callbackURL),
            .init(name: "state", value: state),
            .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        log("update: sign-in: opening the browser (web flow, loopback callback)")
        NSWorkspace.shared.open(c.url!)
    }

    private func startLoopbackListener() -> Bool {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = false
        guard let made = try? NWListener(using: parameters, on: NWEndpoint.Port(rawValue: GitHubSignIn.callbackPort)!) else { return false }
        let group = DispatchGroup(); group.enter()
        var ok = false
        made.newConnectionHandler = { connection in connection.cancel() }     // `start` needs one installed
        made.stateUpdateHandler = { state in
            switch state {
            case .ready: ok = true; group.leave()
            case .failed, .cancelled: group.leave()
            default: break
            }
        }
        made.start(queue: DispatchQueue(label: "deepsea.signin.listener"))
        _ = group.wait(timeout: .now() + 3)
        guard ok else { made.cancel(); return false }
        made.stateUpdateHandler = nil
        made.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener = made
        return true
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .global())
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self else { connection.cancel(); return }
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            // "GET /deepsea-updates/callback?code=…&state=… HTTP/1.1"
            let target = request.split(separator: "\r\n").first?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            let comps = URLComponents(string: "http://127.0.0.1" + target)
            let q = Dictionary(uniqueKeysWithValues: (comps?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
            let good = comps?.path == GitHubSignIn.callbackPath && q["state"] == self.state && !(q["code"] ?? "").isEmpty
            let body = good
                ? "<!doctype html><meta charset=utf-8><title>Signed in</title><body style='font:17px -apple-system,system-ui;text-align:center;padding:12vh 24px;color:#333'>Signed in — you can go back to \(GitHubSignIn.escape(self.appName)).</body>"
                : "<!doctype html><meta charset=utf-8><title>Sign-in failed</title><body style='font:17px -apple-system,system-ui;text-align:center;padding:12vh 24px;color:#333'>That sign-in did not match the request from \(GitHubSignIn.escape(self.appName)). Try again from the app.</body>"
            let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body
            connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            guard good else {
                if comps?.path == GitHubSignIn.callbackPath { self.log("update: sign-in: callback rejected (state mismatch or no code)") }
                return
            }
            self.exchange(code: q["code"]!)
        }
    }

    private func exchange(code: String) {
        let r = GitHubSignIn.postSync(oauthBase + "/login/oauth/access_token", [
            "client_id": clientId, "client_secret": clientSecret ?? "", "code": code,
            "redirect_uri": GitHubSignIn.callbackURL, "code_verifier": verifier,
        ], userAgent: userAgent)
        DispatchQueue.main.async {
            if let token = r.json?["access_token"] as? String {
                self.log("update: sign-in: authorized (web flow)")
                NSApp.activate(ignoringOtherApps: true)
                self.finish(token)
            } else {
                let why = r.json?["error_description"] as? String ?? r.json?["error"] as? String ?? "HTTP \(r.status)"
                self.log("update: sign-in: token exchange failed: \(why)")
                self.fail("GitHub did not issue a token (\(why)).")
            }
        }
    }

    // MARK: device flow (fallback)

    private func startDeviceFlow(on window: NSWindow?) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let r = GitHubSignIn.postSync(self.oauthBase + "/login/device/code", ["client_id": self.clientId, "scope": "repo"], userAgent: self.userAgent)
            DispatchQueue.main.async {
                guard let json = r.json, let device = json["device_code"] as? String, let userCode = json["user_code"] as? String,
                      let verify = json["verification_uri"] as? String else {
                    let why = r.json?["error_description"] as? String ?? r.json?["error"] as? String ?? "HTTP \(r.status)"
                    self.log("update: sign-in: device flow did not start (\(why))")
                    self.fail("GitHub did not start the sign-in (\(why)); check the app's client id.")
                    return
                }
                let interval = max(json["interval"] as? Double ?? 5, 1)
                let expires = Date().addingTimeInterval(json["expires_in"] as? Double ?? 900)
                self.log("update: sign-in: device flow started; polling every \(Int(interval)) s")
                self.presentCodeSheet(on: window, code: userCode, verify: verify)
                if let url = URL(string: verify) { NSWorkspace.shared.open(url) }
                self.pollDevice(device: device, interval: interval, expires: expires)
            }
        }
    }

    private func pollDevice(device: String, interval: Double, expires: Date) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var wait = interval
            while let self, !self.finished {
                Thread.sleep(forTimeInterval: wait)
                if self.finished { return }
                guard Date() < expires else { DispatchQueue.main.async { self.fail("The code expired. Try again.") }; return }
                let r = GitHubSignIn.postSync(self.oauthBase + "/login/oauth/access_token", [
                    "client_id": self.clientId, "device_code": device, "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                ], userAgent: self.userAgent)
                if let token = r.json?["access_token"] as? String {
                    self.log("update: sign-in: authorized (device flow)")
                    DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true); self.finish(token) }
                    return
                }
                let err = r.json?["error"] as? String ?? "HTTP \(r.status), no JSON"
                self.log("update: sign-in: \(err)")
                switch err {
                case "authorization_pending": wait = interval
                case "slow_down": wait = (r.json?["interval"] as? Double ?? interval) + 5
                default: DispatchQueue.main.async { self.fail("GitHub ended the sign-in (\(err)).") }; return
                }
            }
        }
    }

    // MARK: sheets

    func makeSheet(title: String, content: NSView, buttons: [(String, Selector?, Bool)]) -> NSPanel {
        let width: CGFloat = 420
        let padding: CGFloat = 20
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 10), styleMask: [.titled], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        let root = NSView()
        let titleField = NSTextField(labelWithString: title)
        titleField.font = NSFont.boldSystemFont(ofSize: 13)
        titleField.alignment = .center
        titleField.lineBreakMode = .byWordWrapping
        titleField.maximumNumberOfLines = 2
        titleField.preferredMaxLayoutWidth = width - 2 * padding
        var y: CGFloat = padding
        let buttonRow = NSStackView()
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 12
        for (label, action, isDefault) in buttons.reversed() {
            let b = NSButton(title: label, target: self, action: action)
            b.bezelStyle = .rounded
            if isDefault { b.keyEquivalent = "\r" }
            if label == "Cancel" { b.keyEquivalent = "\u{1b}" }
            buttonRow.insertArrangedSubview(b, at: 0)
        }
        buttonRow.layoutSubtreeIfNeeded()
        let rowSize = buttonRow.fittingSize
        buttonRow.frame = NSRect(x: width - padding - rowSize.width, y: y, width: rowSize.width, height: rowSize.height)
        root.addSubview(buttonRow)
        y += rowSize.height + 16
        content.frame = NSRect(x: padding, y: y, width: width - 2 * padding, height: content.frame.height)
        root.addSubview(content)
        y += content.frame.height + 12
        let titleSize = titleField.sizeThatFits(NSSize(width: width - 2 * padding, height: 60))
        titleField.frame = NSRect(x: padding, y: y, width: width - 2 * padding, height: titleSize.height)
        root.addSubview(titleField)
        y += titleSize.height + padding
        root.frame = NSRect(x: 0, y: 0, width: width, height: y)
        panel.setContentSize(root.frame.size)
        panel.contentView = root
        return panel
    }

    private func present(_ panel: NSPanel, on window: NSWindow?) {
        sheet = panel
        if let window { window.beginSheet(panel) } else { panel.center(); panel.makeKeyAndOrderFront(nil) }
    }

    func presentWaitingSheet(on window: NSWindow?, hint: String) {
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 10
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: hint)
        label.textColor = .secondaryLabelColor
        row.addArrangedSubview(spinner)
        row.addArrangedSubview(label)
        row.layoutSubtreeIfNeeded()
        let fit = row.fittingSize
        // Centred within the content width: a container of the full width holding the row in its middle.
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 24))
        row.frame = NSRect(x: (380 - fit.width) / 2, y: (24 - fit.height) / 2, width: fit.width, height: fit.height)
        box.addSubview(row)
        let panel = makeSheet(title: "Sign in to GitHub for \(appName) updates", content: box,
                              buttons: [("Use a Code Instead", #selector(useCodeInstead), false), ("Cancel", #selector(cancel), false)])
        present(panel, on: window)
    }

    private var currentCode = ""
    private var currentVerify = ""

    func presentCodeSheet(on window: NSWindow?, code: String, verify: String) {
        currentCode = code; currentVerify = verify
        if let old = sheet, let parent = old.sheetParent { parent.endSheet(old) } else { sheet?.orderOut(nil) }
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 98))
        let codeField = NSTextField(labelWithString: code)
        codeField.isSelectable = true
        codeField.font = NSFont.monospacedSystemFont(ofSize: 30, weight: .semibold)
        codeField.alignment = .center
        codeField.frame = NSRect(x: 0, y: 52, width: 380, height: 40)
        let link = NSTextField(labelWithString: "")
        link.isSelectable = true
        link.allowsEditingTextAttributes = true
        link.alignment = .center
        let centred = NSMutableParagraphStyle(); centred.alignment = .center
        link.attributedStringValue = NSAttributedString(string: verify, attributes: [.link: verify, .font: NSFont.systemFont(ofSize: 12), .paragraphStyle: centred])
        link.frame = NSRect(x: 0, y: 24, width: 380, height: 18)
        let hint = NSTextField(labelWithString: "Enter the code, then click Authorize.")
        hint.textColor = .secondaryLabelColor
        hint.font = NSFont.systemFont(ofSize: 11)
        hint.alignment = .center
        hint.frame = NSRect(x: 0, y: 0, width: 380, height: 16)
        box.addSubview(codeField); box.addSubview(link); box.addSubview(hint)
        let panel = makeSheet(title: "Sign in to GitHub for \(appName) updates", content: box,
                              buttons: [("Copy Code", #selector(copyCode), false), ("Open GitHub", #selector(openGitHub), false), ("Cancel", #selector(cancel), false)])
        present(panel, on: window)
    }

    @objc private func cancel() { log("update: sign-in: cancelled"); finish(nil) }
    @objc private func copyCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(currentCode, forType: .string)
    }
    @objc private func openGitHub() { if let url = URL(string: currentVerify) { NSWorkspace.shared.open(url) } }
    @objc private func useCodeInstead() {
        let window = sheet?.sheetParent
        listener?.cancel(); listener = nil
        startDeviceFlow(on: window)
    }

    private func fail(_ message: String) {
        let parent = sheet?.sheetParent
        finish(nil)
        let alert = NSAlert()
        alert.messageText = "Sign-in failed"
        alert.informativeText = message
        if let parent { alert.beginSheetModal(for: parent) } else { alert.runModal() }
    }

    // MARK: helpers

    static func postSync(_ url: String, _ form: [String: String], userAgent: String) -> (json: [String: Any]?, status: Int) {
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        var cs = CharacterSet.urlQueryAllowed; cs.remove(charactersIn: "&+=")
        request.httpBody = form.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: cs) ?? "")" }.joined(separator: "&").data(using: .utf8)
        request.timeoutInterval = 20
        var result: (json: [String: Any]?, status: Int) = (nil, 0)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            result = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any], (response as? HTTPURLResponse)?.statusCode ?? 0)
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 30)
        return result
    }

    static func random(_ bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return data.base64URL
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

private extension Data {
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
