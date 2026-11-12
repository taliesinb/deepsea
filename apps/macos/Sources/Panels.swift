// Floating panels for the page: `__DEEPSEA_APP__.showPanel({ id, url, width, height, title })`
// and `__DEEPSEA_APP__.closePanel(id)`. A panel is a small window of its own, above normal windows
// and on every Space, that shows one page of this app's server: a plugin uses it for something the
// person must see even when DeepSea is not in front or shows another session (tool-system-permissions'
// waiting card, say).
//
//   - The URL is resolved against the asking page and must be in the app's scope (its server), so a
//     panel is admitted like the main page: it shares the main web view's data store (cookies,
//     storage), user scripts and this message handler.
//   - One panel per id, app-wide: showing an id again brings that panel forward (loading the new URL
//     when it differs), whichever window asked.
//   - It does not take focus when it appears (a non-activating panel ordered front, never made key);
//     clicking in it works without bringing the main window forward.
//   - Every page of the app (the main window, popups, panels) gets a `deepsea-app-panel` event,
//     `{ id, state: 'opened' | 'closed', by: 'page' | 'user' }`, so each knows when the person closed one.
//   - A hidden test build's panels are invisible and click-through like its main window; the automation
//     channel reaches them (`panels`, `panel-eval`, `panel-snapshot`).

import Cocoa
import WebKit

/// One panel: its window, its page and what it was asked to show.
final class PagePanel {
    let id: String
    let window: NSPanel
    let webView: WKWebView
    var url: URL
    /// Set while the app closes it itself, so the close is reported as the page's, not the person's.
    var closingByPage = false

    init(id: String, window: NSPanel, webView: WKWebView, url: URL) {
        self.id = id
        self.window = window
        self.webView = webView
        self.url = url
    }
}

/// The NSPanel subclass: it may become key (for typing in a field) only when clicked.
final class PagePanelWindow: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

extension AppDelegate {
    /// The page API, every frame (the handler answers only pages of this app's server).
    static let panelScript = """
    globalThis.__DEEPSEA_APP__ = Object.assign(globalThis.__DEEPSEA_APP__ || {}, {
      showPanel: (options) => { try { const o = options || {}; webkit.messageHandlers.deepseaApp.postMessage({ type: 'show-panel', id: String(o.id || ''), url: String(o.url || ''), width: Number(o.width) || 0, height: Number(o.height) || 0, title: o.title == null ? '' : String(o.title) }) } catch {} },
      closePanel: (id) => { try { webkit.messageHandlers.deepseaApp.postMessage({ type: 'close-panel', id: String(id || '') }) } catch {} },
    });
    """

    /// Clamp a requested panel size to something that fits a screen.
    static func panelSize(width: Double, height: Double) -> NSSize {
        NSSize(width: min(900, max(260, width > 0 ? width : 480)), height: min(900, max(120, height > 0 ? height : 260)))
    }

    /// `show-panel` / `close-panel` from a page; false when the message is not one of these.
    func handlePanelMessage(_ body: [String: Any], _ message: WKScriptMessage) -> Bool {
        let type = body["type"] as? String
        guard type == "show-panel" || type == "close-panel" else { return false }
        let id = (body["id"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty, id.count <= 200 else { appendLog("[panel] refused: no id"); return true }
        guard pageServer(message.frameInfo) != nil else {
            appendLog("[panel] refused from \(message.frameInfo.request.url?.absoluteString ?? "a frame"): not this app's page")
            return true
        }
        if type == "close-panel" { closePanel(id, by: "page"); return true }
        let base = message.frameInfo.request.url ?? message.webView?.url
        guard let raw = body["url"] as? String, let url = URL(string: raw, relativeTo: base)?.absoluteURL, scope.contains(url) else {
            appendLog("[panel] refused \(id): \(body["url"] as? String ?? "no url") is not on this app's server")
            return true
        }
        let size = Self.panelSize(width: (body["width"] as? NSNumber)?.doubleValue ?? 0, height: (body["height"] as? NSNumber)?.doubleValue ?? 0)
        showPanel(id: id, url: url, size: size, title: body["title"] as? String ?? "")
        return true
    }

    func showPanel(id: String, url: URL, size: NSSize, title: String) {
        if let panel = panels[id] {
            if panel.url != url { panel.url = url; panel.webView.load(URLRequest(url: url)) }
            if !title.isEmpty { panel.window.title = title }
            panel.window.orderFrontRegardless()
            appendLog("[panel] \(id): forward")
            return
        }
        let configuration = webView.configuration.copy() as! WKWebViewConfiguration
        let view = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.autoresizingMask = [.width, .height]
        if #available(macOS 13.3, *) { view.isInspectable = true }
        let window = PagePanelWindow(contentRect: NSRect(origin: .zero, size: size),
                                     styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                                     backing: .buffered, defer: false)
        window.title = title.isEmpty ? config.name : title
        window.contentView = view
        window.isFloatingPanel = true
        window.level = .floating
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.tabbingMode = .disallowed
        // Top right of the screen the main window is on, clear of the menu bar.
        let screen = self.window?.screen ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: visible.maxX - window.frame.width - 20, y: visible.maxY - window.frame.height - 20))
        }
        if options.hidden {
            // As the hidden main window: there for the automation, invisible and click-through.
            window.alphaValue = 0.01
            window.ignoresMouseEvents = true
            window.hasShadow = false
        }
        let panel = PagePanel(id: id, window: window, webView: view, url: url)
        panels[id] = panel
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self, weak panel] _ in
            guard let self, let panel, self.panels[panel.id] === panel else { return }
            self.panels.removeValue(forKey: panel.id)
            let by = panel.closingByPage ? "page" : "user"
            self.appendLog("[panel] \(panel.id): closed by the \(by)")
            self.broadcastPanelEvent(id: panel.id, state: "closed", by: by)
        }
        view.load(URLRequest(url: url))
        window.orderFrontRegardless()
        appendLog("[panel] \(id): \(url.absoluteString) \(Int(size.width))x\(Int(size.height))")
        broadcastPanelEvent(id: id, state: "opened", by: "page")
    }

    func closePanel(_ id: String, by: String) {
        guard let panel = panels[id] else { return }
        panel.closingByPage = by == "page"
        panel.window.close()
    }

    /// Every page of the app: the main window, popups and panels.
    var allPageViews: [WKWebView] {
        [webView].compactMap { $0 } + popupViews + panels.values.map(\.webView)
    }

    func broadcastPanelEvent(id: String, state: String, by: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "state": state, "by": by]),
              let detail = String(data: data, encoding: .utf8) else { return }
        let js = "window.dispatchEvent(new CustomEvent('deepsea-app-panel', { detail: \(detail) }))"
        for view in allPageViews { view.evaluateJavaScript(js, completionHandler: nil) }
    }

    /// For the automation's `panels`.
    func panelList() -> [[String: Any]] {
        panels.values.sorted { $0.id < $1.id }.map { panel in
            let frame = panel.window.frame
            return [
                "id": panel.id,
                "url": panel.webView.url?.absoluteString ?? panel.url.absoluteString,
                "title": panel.window.title,
                "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
                "visible": panel.window.isVisible,
                "level": panel.window.level.rawValue,
                "floating": panel.window.isFloatingPanel,
                "allSpaces": panel.window.collectionBehavior.contains(.canJoinAllSpaces),
                "key": panel.window.isKeyWindow,
                "loading": panel.webView.isLoading,
            ]
        }
    }
}
