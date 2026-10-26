// DeepSea — the macOS app: a native window (WKWebView) around the DeepSea web
// GUI of one variant. Its bundle id is the variant name (LAYOUT.md §1).
//
// What it does beyond loading a URL:
//   - picks the entry point on every launch: the configured URL when it answers
//     (any HTTP status: an always-on relay answers 503 while the server boots;
//     but 421, the variant refusing that tailnet name, counts as no answer),
//     else the fallback URL with the standing token from the token file, else
//     an offline page that retries; a page load the tailnet address answers
//     with 421 goes to the fallback URL too;
//   - sets `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }` at document
//     start so the shell treats the page as the operator's machine
//     (`ctx.connection.isLoopback`: Settings persist on the host);
//   - carries its identity into the page: `globalThis.__DEEPSEA_APP__ =
//     { name, glyphColor, view, openExternal }` and a `<style>` that renames the
//     sidebar wordmark ("DSH Local Build" → the app name) and colours the whale
//     like the app icon (Resources/desktop-branding.js), and titles the window
//     with the app name;
//   - opens links that leave its mount (other ports, other hosts, every
//     window.open) in the default browser;
//   - when the server is another Mac, makes `localhost` / `127.0.0.1` links
//     work: they name the server's loopback, so the port is forwarded over a
//     WebSocket per connection first (PortForward.swift; the server's
//     `api/deepsea-tailscale/loopback-forward` route). View ▸ Forwarded Ports lists them;
//   - View ▸ Desktop / Mobile: Mobile stamps `<html data-deepsea-view="mobile">`
//     (a document-start script, also applied live) and resizes the window to a
//     phone's content size (390×844) so `max-width` media queries fire;
//   - <App> ▸ Settings… (⌘,) toggles the GUI's Settings panel (a browser keeps
//     ⌘, for itself; here the menu bar is ours);
//   - an integrated title bar: transparent and title-less, the page fills the
//     window, the traffic lights at (16, 18) like the upstream desktop shell,
//     the window material showing through the sidebar column (View ▸ Window
//     Material: Frosted, or Liquid Glass on macOS 26+). The page is told it runs
//     in the macOS desktop shell (`<html data-platform="darwin">`, which the
//     shipped client's layout keys on). WKWebView ignores
//     `-webkit-app-region`, so a document-start script reports mousedowns on the
//     client's drag regions and the app drags the window; the page's theme
//     choice sets the window appearance;
//   - View ▸ Save / Copy Window Snapshot and Element Snapshot (Snapshots.swift;
//     files in the variant's log directory, Paths.swift);
//   - standard menus (⌘R reload, zoom, full screen, Open in Browser), Web
//     Inspector enabled, downloads into ~/Downloads (or --downloads), page errors and failed
//     requests in the run log.
//
// Configuration: `Contents/Resources/deepsea-app.json`, written by build.mjs:
//   { "name": "DeepSea", "url": "https://<node>.example.ts.net/deepsea/",
//     "fallbackUrl": "http://127.0.0.1:3203/", "tokenFile": "<home>/plugins/tailscale/state.json",
//     "glyphColor": "#30A46C" }
//
// Launch flags (test builds started by dsd; an installed app gets none):
//   --url <url>             load this URL instead of the configured entry points
//   --ephemeral             non-persistent WebKit store and preferences: nothing is kept
//   --hidden                an invisible, click-through window that still renders;
//                           the app never takes focus and has no Dock tile
//   --automation <socket>   accept automation requests on this Unix socket (Automation.swift)
//   --downloads <dir>       save downloads here instead of ~/Downloads

import Cocoa
import WebKit

struct AppConfig: Decodable {
    var name: String
    var url: String
    var fallbackUrl: String?
    var tokenFile: String?
    var glyphColor: String?

    /// Product title the shipped client uses for the wordmark and `document.title`.
    static let genericProductTitle = "DSH Local Build"

    /// The bundled identity script, called with this app's name and glyph colour.
    func identityScript() -> String {
        guard let url = Bundle.main.url(forResource: "desktop-branding", withExtension: "js"),
              let script = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("DeepSea: missing desktop-branding.js resource")
            return ""
        }
        let payload = (try? JSONSerialization.data(withJSONObject: ["name": name, "glyphColor": glyphColor ?? ""]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return "\(script)(\(payload));"
    }

    /// The bundle's configuration, with the launch options applied (`--url` replaces every entry point).
    static func load(_ options: LaunchOptions) -> AppConfig {
        var config = AppConfig(name: "DeepSea", url: "http://127.0.0.1:3200/", fallbackUrl: nil, tokenFile: nil, glyphColor: nil)
        if let url = Bundle.main.url(forResource: "deepsea-app", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(AppConfig.self, from: data) {
            config = decoded
        }
        if let url = options.url {
            config.url = url
            config.fallbackUrl = nil
            config.tokenFile = nil
        }
        return config
    }
}

/// Launch flags (see the header). AppKit adds arguments of its own (`-NSDocumentRevisionsDebugMode YES`, …); only ours are read.
struct LaunchOptions {
    var url: String?
    var ephemeral = false
    var hidden = false
    var automation: String?
    var downloads: String?

    static func parse(_ arguments: [String] = Array(CommandLine.arguments.dropFirst())) -> LaunchOptions {
        var options = LaunchOptions()
        var rest = arguments[...]
        while let arg = rest.popFirst() {
            switch arg {
            case "--url": options.url = rest.popFirst()
            case "--ephemeral": options.ephemeral = true
            case "--hidden": options.hidden = true
            case "--automation": options.automation = rest.popFirst()
            case "--downloads": options.downloads = rest.popFirst()
            default: break
            }
        }
        return options
    }
}

/// The app's own preferences. With `--ephemeral` they live in memory only, so a test build leaves
/// no `~/Library/Preferences/<bundle id>.plist` behind.
enum Prefs {
    static var ephemeral = false
    private static var memory: [String: String] = [:]

    static func string(_ key: String) -> String? { ephemeral ? memory[key] : UserDefaults.standard.string(forKey: key) }
    static func set(_ value: String, _ key: String) {
        if ephemeral { memory[key] = value } else { UserDefaults.standard.set(value, forKey: key) }
    }
}

/// Matches URLs that belong to the app: same origin as one of the entry points
/// and inside its path prefix (`/deepsea/`). Everything else is "foreign".
struct Scope {
    let origins: [(scheme: String, host: String, port: Int, pathPrefix: String)]

    init(urls: [URL]) {
        origins = urls.map { url in
            let scheme = url.scheme ?? "https"
            let port = url.port ?? (scheme == "https" ? 443 : 80)
            var prefix = url.path
            if !prefix.hasSuffix("/") { prefix += "/" }
            return (scheme, (url.host ?? "").lowercased(), port, prefix)
        }
    }

    func contains(_ url: URL) -> Bool {
        mountBase(for: url) != nil
    }

    /// The mount directory (`https://node/deepsea/`) of the entry point a URL belongs to, or nil when foreign.
    func mountBase(for url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        let host = (url.host ?? "").lowercased()
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        let path = url.path.isEmpty ? "/" : url.path
        guard let origin = origins.first(where: { origin in
            origin.scheme == scheme && origin.host == host && origin.port == port
                && (path == String(origin.pathPrefix.dropLast()) || path.hasPrefix(origin.pathPrefix))
        }) else { return nil }
        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host
        if origin.port != (origin.scheme == "https" ? 443 : 80) { components.port = origin.port }
        components.path = origin.pathPrefix
        return components.url
    }
}

/// View ▸ Desktop / Mobile. The raw value is what the page sees in
/// `document.documentElement.dataset.deepseaView` (absent for desktop).
enum ViewMode: String {
    case desktop, mobile

    static let defaultsKey = "deepsea.viewMode"
    static let desktopFrameKey = "deepsea.desktopFrame"
    /// iPhone 14/15 CSS viewport; matches the phone-ui plugin's ≤640px query with room to spare.
    static let mobileContentSize = NSSize(width: 390, height: 844)

    static var stored: ViewMode {
        get { Prefs.string(defaultsKey).flatMap(ViewMode.init(rawValue:)) ?? .desktop }
        set { Prefs.set(newValue.rawValue, defaultsKey) }
    }

    /// Document-start script: stamp the flag before the client's first paint
    /// and publish it beside the app identity (`__DEEPSEA_APP__.view`).
    var script: String {
        let set = self == .mobile
            ? "document.documentElement.setAttribute('data-deepsea-view','mobile');"
            : "document.documentElement.removeAttribute('data-deepsea-view');"
        return "(function(){\(set)globalThis.__DEEPSEA_APP__=Object.assign(globalThis.__DEEPSEA_APP__||{},{view:'\(rawValue)'});})();"
    }
}

/// The main window. With the traffic lights moved out of their stock spot
/// (AppDelegate.layoutTrafficLights), AppKit's own rollover tracking no longer
/// covers them and the buttons would never draw their × – + glyphs: the frame
/// asks the window `_mouseInGroup:` (private) before drawing each button, and
/// the delegate keeps `pointerOverTrafficLights` current from a tracking area
/// over the moved group — the same arrangement Electron's `trafficLightPosition`
/// uses.
final class AppWindow: NSWindow {
    var pointerOverTrafficLights = false

    @objc(_mouseInGroup:) func mouseInGroup(_ button: NSButton) -> Bool { pointerOverTrafficLights }
}

/// View ▸ Window Material: what the transparent page sits on.
enum WindowMaterial: String {
    /// `NSVisualEffectView` sidebar material, behind-window blur (default).
    case frosted
    /// The same blur with an `NSGlassEffectView` (macOS 26+) between it and the page.
    case liquidGlass

    static let defaultsKey = "deepsea.windowMaterial"

    static var stored: WindowMaterial {
        get { Prefs.string(defaultsKey).flatMap(WindowMaterial.init(rawValue:)) ?? .frosted }
        set { Prefs.set(newValue.rawValue, defaultsKey) }
    }
}

/// The page's web view, with the window-drag regions handled NATIVELY — the
/// Chromium/Electron model for `-webkit-app-region: drag`: the page reports
/// where the title band is draggable (hit-tested rects, see
/// `titlebarBridgeScript`), and a primary mousedown inside one is consumed
/// here, before WebKit ever sees it. The earlier design (page `mousedown` →
/// message → `performDrag` with `NSApp.currentEvent`) was fickle by
/// construction: the message crossed from the WebContent process after WebKit
/// had already begun a text selection, and by then the current event was
/// often no longer the mousedown, so the guard failed and the click merely
/// selected header text.
///
/// Everything in the band that is not a hard control (icon buttons, the
/// header's action/utility buttons, tabs, inputs, menus) drags — including
/// text and the soft triggers such as the session title and the mode chip.
/// A press there is tracked natively: movement beyond the threshold moves the
/// window; release without movement replays press + release into WebKit, so
/// a click on the title still opens its picker. This is the native title-bar
/// contract (drag anywhere, click what is clickable).
final class AppWebView: WKWebView {
    /// Draggable rects in CSS px of the viewport (origin top-left), as the page last reported them.
    var dragRegions: [NSRect] = [] {
        didSet { if dragRegions.count != oldValue.count { onDragRegionsChanged?(dragRegions.count) } }
    }
    var onDragRegionsChanged: ((Int) -> Void)?
    /// The title-bar double-click action (System Settings ▸ Desktop & Dock).
    var onTitlebarDoubleClick: (() -> Void)?
    /// Set by the automation channel around the events it dispatches: no real
    /// button is down, so a press in a drag region is not tracked (that would
    /// wait for a mouse-up that never comes) but recorded in `dragRegionHit`
    /// and passed to WebKit like any click.
    var syntheticInput = false
    var dragRegionHit = false
    /// Points of travel before a press becomes a drag (AppKit's own drag slop).
    static let dragThreshold: CGFloat = 3

    /// The event's location in CSS px of the viewport, nil when it cannot be mapped
    /// (pinch-zoomed: `magnification` moves the origin; fall through to WebKit).
    func cssPoint(of event: NSEvent) -> NSPoint? {
        guard magnification == 1, pageZoom > 0 else { return nil }
        let p = convert(event.locationInWindow, from: nil)
        let fromTop = isFlipped ? p.y : bounds.height - p.y
        return NSPoint(x: p.x / pageZoom, y: fromTop / pageZoom)
    }

    func inDragRegion(_ event: NSEvent) -> Bool {
        guard let css = cssPoint(of: event) else { return false }
        return dragRegions.contains(where: { $0.contains(css) })
    }

    override func mouseDown(with event: NSEvent) {
        guard event.type == .leftMouseDown, let window, inDragRegion(event) else { return super.mouseDown(with: event) }
        if syntheticInput { dragRegionHit = true; return super.mouseDown(with: event) }
        if event.clickCount >= 2 { onTitlebarDoubleClick?(); return }
        // Track the press ourselves: drag → window drag; plain click → replayed to WebKit.
        let origin = event.locationInWindow
        while true {
            guard let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: .distantFuture, inMode: .eventTracking, dequeue: true) else { continue }
            if next.type == .leftMouseUp {
                super.mouseDown(with: event)
                super.mouseUp(with: next)
                return
            }
            if hypot(next.locationInWindow.x - origin.x, next.locationInWindow.y - origin.y) >= Self.dragThreshold {
                window.performDrag(with: event)
                return
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, NSWindowDelegate, NSMenuDelegate {
    let options = LaunchOptions.parse()
    lazy var config = AppConfig.load(options)
    var automation: Automation?
    var window: AppWindow!
    var webView: AppWebView!
    var viewMode: ViewMode = ViewMode.stored
    var desktopMenuItem: NSMenuItem!
    var mobileMenuItem: NSMenuItem!
    var windowMaterial: WindowMaterial = WindowMaterial.stored
    var frostedMenuItem: NSMenuItem!
    var liquidGlassMenuItem: NSMenuItem!
    var scope: Scope!
    var forwarder: PortForwarder!
    let forwardedPortsMenu = NSMenu(title: "Forwarded Ports")
    /// Last refusal shown per remote port, so a failing iframe does not stack alerts.
    private var lastForwardAlert: [Int: Date] = [:]
    var titleObservation: NSKeyValueObservation?
    var showingOfflinePage = false
    /// A page (not the offline page) has finished loading at least once.
    var pageLoaded = false
    var retryTimer: Timer?
    var connecting = false

    var remoteURL: URL { URL(string: config.url)! }
    var fallbackBase: URL? { config.fallbackUrl.flatMap(URL.init(string:)) }

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        Prefs.ephemeral = options.ephemeral
        // Hidden test builds never take focus and have no Dock tile.
        NSApp.setActivationPolicy(options.hidden ? .accessory : .regular)
        appendLog("launch: \(Bundle.main.bundlePath) url \(config.url)\(options.ephemeral ? " ephemeral" : "")\(options.hidden ? " hidden" : "")\(options.automation.map { " automation \($0)" } ?? "")")
        installSnapshotSignal()
        scope = Scope(urls: [remoteURL] + (fallbackBase.map { [$0] } ?? []))
        forwarder = PortForwarder(endpointBase: { [weak self] in self?.currentMountBase() }, log: { [weak self] line in self?.appendLog(line) })
        buildMenu()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = options.ephemeral ? .nonPersistent() : .default()
        if options.hidden {
            // A hidden test window still runs its page at full speed: no occlusion or
            // background throttling of timers, rAF or CSS animations (private preferences
            // reached by KVC, as `drawsBackground` below; ignored if a WebKit drops them).
            for key in ["hiddenPageDOMTimerThrottlingEnabled", "hiddenPageCSSAnimationSuspensionEnabled", "pageVisibilityBasedProcessSuppressionEnabled"] {
                if configuration.preferences.responds(to: NSSelectorFromString("_set\(key.prefix(1).uppercased())\(key.dropFirst()):")) {
                    configuration.preferences.setValue(false, forKey: key)
                }
            }
        }
        configuration.applicationNameForUserAgent = "DeepSea/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0")"
        configuration.preferences.isElementFullscreenEnabled = true
        installUserScripts(into: configuration.userContentController)
        configuration.userContentController.add(self, name: "deepseaApp")

        webView = AppWebView(frame: .zero, configuration: configuration)
        webView.onTitlebarDoubleClick = { [unowned self] in self.titlebarDoubleClick() }
        webView.onDragRegionsChanged = { [unowned self] count in self.appendLog("drag regions: \(count)") }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        // The client paints `html, body` transparent under data-platform=darwin so
        // the window's vibrancy reaches its sidebar column; the view must not
        // paint an opaque base behind the page. (Private `_drawsBackground`,
        // reached through KVC — the same switch Electron's transparent windows use.)
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self else { return }
            // The client titles the page "<session> — DSH Local Build"; this window is named after the app.
            let title = (view.title ?? "")
                .replacingOccurrences(of: AppConfig.genericProductTitle, with: self.config.name)
                .trimmingCharacters(in: .whitespaces)
            self.window.title = title.isEmpty ? self.config.name : title
        }

        window = AppWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = config.name
        // Integrated title bar (Electron `titleBarStyle: 'hiddenInset'`): no title
        // text, no bar fill, no separator; the page owns the top edge and the
        // traffic lights float over it (layoutTrafficLights).
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.tabbingMode = .disallowed
        // Narrow enough for View ▸ Mobile's 390px phone width.
        window.minSize = NSSize(width: 360, height: 320)
        // Window material behind the transparent page (View ▸ Window Material):
        // the client's centre column paints its own opaque base, only the
        // sidebar column lets the material through.
        webView.autoresizingMask = [.width, .height]
        installBackdrop()
        window.delegate = self
        if options.ephemeral {
            window.isRestorable = false
            window.center()
        } else {
            window.setFrameAutosaveName("deepsea.main")
            if !window.setFrameUsingName("deepsea.main") { window.center() }
        }
        layoutTrafficLights()
        syncViewModeMenu()
        if options.hidden {
            // Invisible and click-through, but on screen and above other windows (never key or
            // focused), so WebKit keeps the page running: an occluded window is `hidden` to the
            // page and its CSS animations and timers stop, freezing anything mid-transition.
            // Not fully transparent: macOS counts an alpha-0 window as not visible and the page
            // is then `hidden`. A hundredth is invisible to a person and keeps it `visible`.
            window.alphaValue = 0.01
            window.ignoresMouseEvents = true
            window.hasShadow = false
            window.level = .floating
            window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            window.orderFrontRegardless()
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        // A behind-window material installed before the window is on screen
        // stays opaque for the life of that content view (a cold launch showed a
        // solid sidebar until View ▸ Window Material was toggled, which rebuilds
        // the backdrop on the now-visible window). Rebuild once the window has
        // been ordered front; the page is untouched (the web view is only
        // re-parented, as every material switch does).
        DispatchQueue.main.async { [weak self] in self?.installBackdrop() }
        if let path = options.automation {
            do {
                automation = try Automation(path: path, app: self)
                appendLog("automation: listening on \(path)")
            } catch {
                appendLog("automation: cannot listen on \(path): \(error)")
            }
        }

        connect()
    }

    /// All document-start scripts, in order. Re-run (after `removeAllUserScripts`)
    /// when the view mode changes so the next load already carries the flag.
    func installUserScripts(into controller: WKUserContentController) {
        controller.removeAllUserScripts()
        let ownsHost = WKUserScript(
            source: "globalThis.__DSH_TRANSPORT__=Object.assign(globalThis.__DSH_TRANSPORT__||{},{ownsHost:true});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        controller.addUserScript(ownsHost)
        // The client's macOS-desktop layout mark (apps/desktop's preload sets the
        // same attribute): hiddenInset sidebar strip, header controls for the
        // closed sidebar, transparent page background for the vibrancy.
        controller.addUserScript(WKUserScript(
            source: Self.darwinPlatformScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: Self.titlebarBridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: config.identityScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: viewMode.script,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(
            source: Self.openExternalScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        // Page diagnostics → the run log (Paths.swift): uncaught errors,
        // unhandled rejections and console.error/warn. The wrapper has no
        // dev-tools shortcut, so this is how a "it only happens in the app"
        // report becomes readable (Safari ▸ Develop remains available too).
        controller.addUserScript(WKUserScript(
            source: """
            (() => {
              const post = (level, text) => { try { webkit.messageHandlers.deepseaApp.postMessage({ type: 'console', level, text: String(text).slice(0, 2000) }) } catch {} };
              window.addEventListener('error', e => post('error', (e.message || 'error') + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : '')));
              window.addEventListener('unhandledrejection', e => post('unhandled', e.reason && (e.reason.stack || e.reason.message || e.reason)));
              for (const level of ['error', 'warn']) { const orig = console[level]; console[level] = (...a) => { post(level, a.map(x => { try { return typeof x === 'string' ? x : (x && x.stack) || JSON.stringify(x) } catch { return String(x) } }).join(' ')); orig.apply(console, a) } }
              // Menus: in WKWebView the mousedown default on a Radix menu row moves focus to <body> (the row
              // is not focused on hover as in Chrome/Safari), the menu's focus-outside guard unmounts it
              // before pointerup, and nothing is selected (traced 2026-09-21). Suppress that default for
              // radio/checkbox rows — plain menuitems ("Model ›", which swaps the menu content) work unaided.
              const rowOf = e => e.target && e.target.closest ? e.target.closest('[role="menuitemradio"],[role="menuitemcheckbox"]') : null;
              document.addEventListener('mousedown', e => { if (rowOf(e)) e.preventDefault() }, true);
              // Transport: failed or non-2xx fetches and WebSocket closes — a request the page drops quietly shows up here.
              const origFetch = window.fetch.bind(window);
              const urlOf = input => typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
              window.fetch = async (input, init) => { const url = urlOf(input); const method = (init && init.method) || (input && input.method) || 'GET'; try { const res = await origFetch(input, init); if (res.status >= 400) post('net', method + ' ' + url + ' → ' + res.status); else if (method !== 'GET') post('net', method + ' ' + url + ' → ' + res.status); if (res.status < 400 && method !== 'GET' && /application\\/json/.test(res.headers.get('content-type') || '')) { res.clone().text().then(t => { if (/"ok":\\s*false|"error"/.test(t)) post('rpc', method + ' ' + url + ' → ' + t.slice(0, 600)) }).catch(() => {}) } return res } catch (e) { post('net', method + ' ' + url + ' → failed: ' + (e && e.message || e)); throw e } };
              const OrigWS = window.WebSocket; window.WebSocket = function (url, protocols) { const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols); ws.addEventListener('close', ev => post('net', 'ws close ' + url + ' code ' + ev.code + (ev.reason ? ' ' + ev.reason : ''))); ws.addEventListener('error', () => post('net', 'ws error ' + url)); ws.addEventListener('message', ev => { if (typeof ev.data === 'string' && /"ok":\\s*false|"error"/.test(ev.data)) post('rpc', 'ws ← ' + ev.data.slice(0, 600)) }); const origSend = ws.send.bind(ws); ws.send = data => { if (typeof data === 'string' && /selection|model/i.test(data)) post('rpc', 'ws → ' + data.slice(0, 300)); return origSend(data) }; return ws }; window.WebSocket.prototype = OrigWS.prototype; Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    /// `<html data-platform="darwin">`, set before the client's first paint. At
    /// document start the root element exists; the DOMContentLoaded fallback
    /// mirrors apps/desktop/src/preload-platform.ts.
    static let darwinPlatformScript = """
    (function(){var m=function(){document.documentElement.dataset.platform='darwin'};if(document.documentElement)m();else addEventListener('DOMContentLoaded',m);})();
    """

    /// Title-bar behaviour the page cannot get from WebKit alone:
    ///   - drag regions: the top 52 CSS px of the page (the client's title band
    ///     — the sidebar strip, the conversation title row; what the shipped CSS
    ///     marks `-webkit-app-region: drag`, which WKWebView ignores) is
    ///     reported to the app as HIT-TESTED rects: every 6px column of each
    ///     8px strip of the band is probed with `elementFromPoint`, and a point
    ///     is draggable unless it lands on a hard control (icon buttons, the
    ///     header's action/utility/corner buttons, tabs, inputs, menus and
    ///     popups, the sidebar resize handle) or under a resize/grab/crosshair
    ///     cursor (so an element pick, which sets crosshair everywhere, gets its
    ///     click). Text, padding and soft triggers (session title, mode chip)
    ///     drag; AppWebView tracks the press and replays a movement-free one to
    ///     WebKit as a click. Re-reported (coalesced, ≤ 10/s, trailing 250ms) on
    ///     DOM/attribute mutations, resize, scroll and transition/animation end.
    ///   - the same mousedown, should it still reach the page (the map is at
    ///     most a frame stale), is defaulted away so no selection starts, and
    ///     reported as before (best-effort fallback drag). The title regions are
    ///     also made non-selectable, as under Electron.
    ///   - theme: `html[data-ds-theme-source]` (`light`/`dark`/`system`, set by
    ///     the client's theme presenter) is reported on load and on change so the
    ///     window appearance, hence the vibrancy material, follows the page.
    /// The class selectors match the `<hash>_<local>` names CSS modules compile to.
    /// `__DEEPSEA_APP__.openExternal(url)`: open a URL in the user's default browser
    /// without a click in progress (a page-initiated `window.open` needs one in
    /// WKWebView). Used by the login command to open a sign-in page the moment
    /// the server returns it. Same-origin frames (a framed remote session) reach
    /// it through `window.top`.
    static let openExternalScript = """
    globalThis.__DEEPSEA_APP__ = Object.assign(globalThis.__DEEPSEA_APP__ || {}, {
      openExternal: url => { try { webkit.messageHandlers.deepseaApp.postMessage({ type: 'open-url', url: String(url) }) } catch {} },
    });
    """

    static let titlebarBridgeScript = """
    (() => {
      const post = body => { try { webkit.messageHandlers.deepseaApp.postMessage(body) } catch {} };
      const picking = () => !!(globalThis.__DEEPSEA_INSPECT__ && globalThis.__DEEPSEA_INSPECT__.picking);
      // Hard controls: forwarded to the page at once, never drag. Icon buttons
      // (aria-label, no text), the header's action/utility/corner buttons, tabs,
      // inputs, menus and their popups, the sidebar resize handle.
      const hard = 'a,input,textarea,select,summary,[contenteditable],[role="tab"],[role="menuitem"],[role="menu"],[role="listbox"],[role="dialog"],[role="slider"],[role="switch"],[role="checkbox"],[data-radix-popper-content-wrapper],button[aria-label],[role="button"][aria-label],[class*="_headerActions"] button,[class*="_headerUtilities"] button,[class*="_headerCorner"] button,[class*="_handle"],[class*="_resizer"]';
      const band = 52, strip = 8, step = 6;
      const noDragCursor = /resize|grab|crosshair/;
      const softAt = (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest(hard)) return false;
        return !noDragCursor.test(getComputedStyle(el).cursor);
      };
      let last = '';
      const report = () => {
        const rects = [];
        if (!picking()) {
          const width = Math.min(innerWidth, document.documentElement.clientWidth);
          for (let top = 0; top < band; top += strip) {
            const y = top + strip / 2;
            let run = null;
            const flush = () => { if (run) { rects.push([run[0], top, run[1] - run[0], strip]); run = null } };
            for (let x = step / 2; x < width; x += step) {
              if (softAt(x, y)) { if (run) run[1] = x + step / 2; else run = [x - step / 2, x + step / 2] }
              else flush();
            }
            flush();
          }
        }
        const key = JSON.stringify(rects);
        if (key !== last) { last = key; post({ type: 'dragRegions', rects }) }
      };
      let pending = false, lastRun = 0, trailing;
      const run = () => { lastRun = performance.now(); report() };
      const schedule = () => {
        clearTimeout(trailing); trailing = setTimeout(run, 250);
        if (pending) return;
        pending = true;
        setTimeout(() => requestAnimationFrame(() => { pending = false; run() }), Math.max(0, 100 - (performance.now() - lastRun)));
      };
      const start = () => {
        const style = document.createElement('style');
        style.textContent = 'html[data-platform="darwin"] [class*="_topStrip"],html[data-platform="darwin"] [class*="_titleRow"]{-webkit-user-select:none;user-select:none}';
        document.head.appendChild(style);
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-state', 'data-open', 'data-sidebar-collapsed', 'aria-expanded', 'aria-hidden', 'aria-label'] });
        new ResizeObserver(schedule).observe(document.documentElement);
        addEventListener('resize', schedule);
        addEventListener('scroll', schedule, true);
        addEventListener('transitionend', schedule, true);
        addEventListener('animationend', schedule, true);
        schedule();
      };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start); else start();
      // Should a press in the band still reach the page (the native map is at
      // most a frame stale), keep it from starting a selection and hand it to
      // the app as a best-effort drag.
      addEventListener('mousedown', e => {
        if (picking()) return;
        if (e.button !== 0 || e.buttons !== 1 || e.clientY > band) return;
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest(hard)) return;
        e.preventDefault();
        post({ type: 'titlebar', clicks: e.detail });
      }, true);
      let sent;
      const theme = () => {
        const value = document.documentElement.getAttribute('data-ds-theme-source');
        if (value !== null && value !== sent) { sent = value; post({ type: 'theme', value }) }
      };
      const observe = () => { new MutationObserver(theme).observe(document.documentElement, { attributeFilter: ['data-ds-theme-source'] }); theme() };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', observe); else observe();
    })();
    """

    // MARK: integrated title bar

    /// Where the close button's frame sits, from the window's top-left — the
    /// upstream Electron shell's `trafficLightPosition: { x: 16, y: 18 }`, which
    /// the client's 52px sidebar top strip is drawn for (16 + 16 + 2·18 = 52).
    static let trafficLightOrigin = NSPoint(x: 16, y: 18)
    /// Stock distance between neighbouring buttons' origins, read once before the first move.
    private var trafficLightSpacing: CGFloat?
    /// Rollover tracking over the moved group (see AppWindow); replaced on every layout.
    private var trafficLightTracking: NSTrackingArea?

    /// Move the traffic lights to `trafficLightOrigin` and grow the title-bar
    /// container to hold them (AppKit lays them out for a 28px bar; a button
    /// outside its container's bounds is not hit-testable). Re-run on every
    /// resize and on leaving full screen, when AppKit rebuilds the bar.
    func layoutTrafficLights() {
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { window.standardWindowButton($0) }
        guard buttons.count == 3, let titlebar = buttons[0].superview, let container = titlebar.superview, let frame = container.superview else { return }
        if trafficLightSpacing == nil { trafficLightSpacing = buttons[1].frame.minX - buttons[0].frame.minX }
        let spacing = trafficLightSpacing ?? 20
        let margin = Self.trafficLightOrigin
        let height = margin.y * 2 + buttons[0].frame.height
        var containerFrame = container.frame
        containerFrame.size.height = height
        containerFrame.origin.y = frame.bounds.height - height
        if container.frame != containerFrame { container.frame = containerFrame }
        if titlebar.frame != container.bounds { titlebar.frame = container.bounds }
        var group = NSRect.null
        for (index, button) in buttons.enumerated() {
            var buttonFrame = button.frame
            buttonFrame.origin = NSPoint(x: margin.x + CGFloat(index) * spacing, y: margin.y)
            if button.frame != buttonFrame { button.frame = buttonFrame }
            group = group.union(buttonFrame)
        }
        if let old = trafficLightTracking, old.rect == group, titlebar.trackingAreas.contains(old) { return }
        if let old = trafficLightTracking { titlebar.removeTrackingArea(old) }
        let tracking = NSTrackingArea(rect: group, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        titlebar.addTrackingArea(tracking)
        trafficLightTracking = tracking
    }

    private func setPointerOverTrafficLights(_ inside: Bool) {
        guard window.pointerOverTrafficLights != inside else { return }
        window.pointerOverTrafficLights = inside
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(type)?.needsDisplay = true }
    }

    // Tracking-area owner callbacks (the delegate is not a responder; these are plain selectors).
    @objc func mouseEntered(with event: NSEvent) {
        if event.trackingArea === trafficLightTracking { setPointerOverTrafficLights(true) }
    }

    @objc func mouseExited(with event: NSEvent) {
        if event.trackingArea === trafficLightTracking { setPointerOverTrafficLights(false) }
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights(); publishWindowInfo() }
    func windowDidExitFullScreen(_ notification: Notification) { layoutTrafficLights(); publishWindowInfo() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights(); publishWindowInfo() }
    func windowDidResignKey(_ notification: Notification) { publishWindowInfo() }
    func windowDidMove(_ notification: Notification) { publishWindowInfo() }
    func windowDidChangeScreen(_ notification: Notification) { publishWindowInfo() }
    func applicationDidResignActive(_ notification: Notification) { publishWindowInfo() }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView else { return }
        automationLoad = nil
        publishWindowInfo()
        if showingOfflinePage {
            automation?.navigationFailed("the server does not answer (the offline page is showing)")
        } else {
            pageLoaded = true
            automation?.navigationFinished()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView else { return }
        automationLoad = nil
        automation?.navigationFailed(error.localizedDescription)
    }

    // MARK: window cooperation
    //
    // The browser plugin places an agent's browser windows beside the app window
    // that drives them. The page learns this window's frame and screen from
    // `window.__DEEPSEA_APP_WINDOW__` and a `deepsea-app-window` event (sent on
    // every move / resize / screen / focus change and after each load), and may
    // ask the window to resize with `{type: "set-frame", frame}` (to reveal a
    // strip at the right edge for the agent's windows, and to restore it). All
    // rects are global points with a top-left origin, as in CoreGraphics.

    private func topLeftRect(_ r: NSRect) -> [String: Double] {
        let height = Double(NSScreen.screens.first?.frame.height ?? 0)
        return ["x": Double(r.minX), "y": height - Double(r.maxY), "width": Double(r.width), "height": Double(r.height)]
    }

    func windowInfoDictionary() -> [String: Any] {
        var info: [String: Any] = [
            "pid": Int(getpid()),
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "frame": topLeftRect(window.frame),
            "key": window.isKeyWindow,
            "active": NSApp.isActive,
            "fullScreen": window.styleMask.contains(.fullScreen),
        ]
        if let screen = window.screen ?? NSScreen.main {
            info["screen"] = ["frame": topLeftRect(screen.frame), "visible": topLeftRect(screen.visibleFrame)]
        }
        return info
    }

    func publishWindowInfo() {
        guard window != nil, webView != nil else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: windowInfoDictionary()), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__DEEPSEA_APP_WINDOW__=\(json);window.dispatchEvent(new CustomEvent('deepsea-app-window',{detail:\(json)}))", completionHandler: nil)
    }

    /// `{type: "set-frame", frame: {x, y, width, height}}` (top-left global points) from the main page.
    func applyRequestedFrame(_ raw: Any?) {
        guard let window, let f = raw as? [String: Any],
              let x = (f["x"] as? NSNumber)?.doubleValue, let y = (f["y"] as? NSNumber)?.doubleValue,
              let w = (f["width"] as? NSNumber)?.doubleValue, let h = (f["height"] as? NSNumber)?.doubleValue,
              w >= 320, h >= 240, !window.styleMask.contains(.fullScreen) else { return }
        let primary = Double(NSScreen.screens.first?.frame.height ?? 0)
        let rect = NSRect(x: x, y: primary - y - h, width: w, height: h)
        // Only frames that stay on some screen: a page must not be able to lose the window.
        guard NSScreen.screens.contains(where: { $0.frame.intersects(rect) }) else { return }
        appendLog("set-frame: \(window.frame) -> \(rect)")
        window.setFrame(rect, display: true, animate: true)
    }

    /// System Settings ▸ Desktop & Dock ▸ "Double-click a window's title bar to" (Zoom by default).
    func titlebarDoubleClick() {
        let action = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?["AppleActionOnDoubleClick"] as? String
        switch action {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }

    /// Fallback for a mousedown the page still saw on a drag region (the native
    /// region map is at most a frame stale — a menu that just opened, a layout
    /// mid-transition). Best effort only: the message arrives after the event,
    /// and the current event must still be the press for AppKit to track it.
    func titlebarMouseDown(clicks: Int) {
        if clicks >= 2 { titlebarDoubleClick(); return }
        guard let event = NSApp.currentEvent, event.type == .leftMouseDown || event.type == .leftMouseDragged else { return }
        window.performDrag(with: event)
    }

    /// `html[data-ds-theme-source]` → window appearance, so the sidebar vibrancy
    /// material and the traffic lights follow the page's theme; `system` (or
    /// anything else) follows the OS.
    func applyPageTheme(_ value: String) {
        switch value {
        case "dark": window.appearance = NSAppearance(named: .darkAqua)
        case "light": window.appearance = NSAppearance(named: .aqua)
        default: window.appearance = nil
        }
    }

    // MARK: snapshot signals (the snapshot commands are in Snapshots.swift)

    private var snapshotSignals: [DispatchSourceSignal] = []

    /// `kill -USR1 <pid>` saves a PNG of the window — the way an agent without
    /// Screen Recording or Accessibility permission sees what the wrapper
    /// draws (a process may capture its own windows without either).
    /// `kill -USR2 <pid>` starts Save Element Snapshot: the user picks.
    /// Neither opens Preview (the menu commands do; Snapshots.swift).
    func installSnapshotSignal() {
        let handlers: [(Int32, () -> Void)] = [
            (SIGUSR1, { [weak self] in self?.writeWindowSnapshot(openInPreview: false) }),
            (SIGUSR2, { [weak self] in self?.runSaveElementSnapshot(openInPreview: false) }),
            // `kill` and Ctrl-C quit like ⌘Q, so the automation socket and forwards are cleaned up.
            (SIGTERM, { NSApp.terminate(nil) }),
            (SIGINT, { NSApp.terminate(nil) }),
        ]
        for (number, handler) in handlers {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler(handler: handler)
            source.resume()
            snapshotSignals.append(source)
        }
    }

    // MARK: window material (View ▸ Window Material)

    /// Build the window's content: the material and the page over it. The
    /// frosted material is the standard translucent sidebar vibrancy (Finder's;
    /// Electron's `vibrancy: 'sidebar'`) blurring the desktop behind the
    /// window; the Liquid Glass variant (macOS 26+) adds an `NSGlassEffectView`
    /// between that blur and the page. Re-run when the choice changes.
    func installBackdrop() {
        let bounds = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1280, height: 860)
        // The window itself must compose against the desktop: an opaque window
        // (AppKit's default) paints a solid base under any behind-window material
        // once a glass view has been in the hierarchy (Electron: backgroundColor
        // '#00000000'). Set on every rebuild so a material switch cannot leave the
        // window opaque.
        window.isOpaque = false
        window.backgroundColor = .clear
        let backdrop = NSVisualEffectView(frame: bounds)
        backdrop.material = .sidebar
        backdrop.blendingMode = .behindWindow
        // 'active' keeps the material stable when the window blurs (Electron's `visualEffectState: 'active'`).
        backdrop.state = .active
        webView.removeFromSuperview()
        webView.frame = backdrop.bounds
        // Re-assert after re-parenting: the web view must paint no base of its own
        // (private `_drawsBackground`, the switch Electron's transparent windows use).
        webView.setValue(false, forKey: "drawsBackground")
        if #available(macOS 26.0, *), windowMaterial == .liquidGlass {
            // The glass is a material layer UNDER the page, not the page's host: as
            // `contentView` host it captured the web view into its own backdrop pass
            // and the desktop no longer showed through.
            let glass = NSGlassEffectView(frame: backdrop.bounds)
            glass.autoresizingMask = [.width, .height]
            glass.style = .clear
            backdrop.addSubview(glass)
        }
        backdrop.addSubview(webView)
        window.contentView = backdrop
        syncWindowMaterialMenu()
    }

    @objc func selectFrostedMaterial() { setWindowMaterial(.frosted) }
    @objc func selectLiquidGlassMaterial() { setWindowMaterial(.liquidGlass) }

    func setWindowMaterial(_ material: WindowMaterial) {
        guard material != windowMaterial else { return }
        windowMaterial = material
        WindowMaterial.stored = material
        installBackdrop()
        appendLog("window material: \(material.rawValue)")
    }

    func syncWindowMaterialMenu() {
        frostedMenuItem?.state = windowMaterial == .frosted ? .on : .off
        liquidGlassMenuItem?.state = windowMaterial == .liquidGlass ? .on : .off
        if #available(macOS 26.0, *) {} else { liquidGlassMenuItem?.isEnabled = false }
    }

    // MARK: view mode (View ▸ Desktop / Mobile)

    @objc func selectDesktopView() { setViewMode(.desktop) }
    @objc func selectMobileView() { setViewMode(.mobile) }

    func setViewMode(_ mode: ViewMode, animate: Bool = true) {
        guard mode != viewMode else { return }
        let previous = viewMode
        viewMode = mode
        ViewMode.stored = mode
        // Next load: the document-start script carries the new flag. This load: flip it live.
        installUserScripts(into: webView.configuration.userContentController)
        webView.evaluateJavaScript(mode.script, completionHandler: nil)
        switch (previous, mode) {
        case (.desktop, .mobile):
            Prefs.set(NSStringFromRect(window.frame), ViewMode.desktopFrameKey)
            resizeContentKeepingTopLeft(to: ViewMode.mobileContentSize, animate: animate)
        case (.mobile, .desktop):
            if let saved = Prefs.string(ViewMode.desktopFrameKey) {
                window.setFrame(NSRectFromString(saved), display: true, animate: animate)
            } else {
                resizeContentKeepingTopLeft(to: NSSize(width: 1280, height: 860), animate: animate)
            }
        default:
            break
        }
        syncViewModeMenu()
        appendLog("view mode: \(mode.rawValue)")
    }

    /// Resize the content area, keeping the window's top-left corner where it is (clamped to the screen).
    func resizeContentKeepingTopLeft(to size: NSSize, animate: Bool = true) {
        let contentRect = NSRect(origin: .zero, size: size)
        var frame = window.frameRect(forContentRect: contentRect)
        frame.origin = NSPoint(x: window.frame.minX, y: window.frame.maxY - frame.height)
        if let visible = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
            if frame.height > visible.height { frame.size.height = visible.height }
            frame.origin.y = max(visible.minY, min(frame.origin.y, visible.maxY - frame.height))
            frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.width))
        }
        window.setFrame(frame, display: true, animate: animate)
    }

    func syncViewModeMenu() {
        desktopMenuItem?.state = viewMode == .desktop ? .on : .off
        mobileMenuItem?.state = viewMode == .mobile ? .on : .off
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        forwarder.closeAll()
        automation?.stop()
    }

    /// Whether the server is another machine, so its loopback links need forwarding: the page comes
    /// from a non-loopback address. (A server on this Mac reached through its tailnet name still
    /// counts as remote; forwarding then reaches the same machine, which is harmless.)
    var serverIsRemote: Bool {
        guard let host = currentMountBase()?.host else { return true }
        return !LoopbackLink.isLoopbackHost(host)
    }

    /// The mount the page is loaded from right now (tailnet or loopback fallback), or nil while offline.
    func currentMountBase() -> URL? {
        if showingOfflinePage { return nil }
        if let current = webView.url, let base = scope.mountBase(for: current) { return base }
        return scope.mountBase(for: remoteURL)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag, !options.hidden { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        if showingOfflinePage { connect() }
        publishWindowInfo()
    }

    // MARK: entry point selection

    /// Probe the tailnet URL; any HTTP answer (even the relay's 503 splash) means "reachable",
    /// except 421 Misdirected Request: something answers at that name, but not this variant (its
    /// Tailscale fence knows another name for this node, e.g. just after a tailnet switch).
    func probe(_ url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: .ephemeral)
        session.dataTask(with: request) { [weak self] _, response, _ in
            let http = response as? HTTPURLResponse
            DispatchQueue.main.async {
                if http?.statusCode == 421 { self?.appendLog("[probe] HTTP 421 Misdirected Request: \(url.absoluteString)") }
                completion(http != nil && http?.statusCode != 421)
            }
            session.finishTasksAndInvalidate()
        }.resume()
    }

    func fallbackURL() -> URL? {
        guard let base = fallbackBase else { return nil }
        guard let file = config.tokenFile, let data = FileManager.default.contents(atPath: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, !token.isEmpty else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url
    }

    @objc func connect() {
        if connecting { return }
        connecting = true
        retryTimer?.invalidate()
        // A variant without a tailnet URL has only its relay on this machine: log in through it at once.
        let local = fallbackBase.map { $0.scheme == remoteURL.scheme && $0.host == remoteURL.host && $0.port == remoteURL.port } ?? false
        let first = local ? (fallbackURL() ?? remoteURL) : remoteURL
        probe(first) { [weak self] reachable in
            guard let self else { return }
            self.connecting = false
            if reachable {
                self.showingOfflinePage = false
                self.webView.load(URLRequest(url: first))
                return
            }
            if let fallback = self.fallbackURL() {
                self.probe(fallback) { [weak self] localReachable in
                    guard let self else { return }
                    if localReachable {
                        self.showingOfflinePage = false
                        self.webView.load(URLRequest(url: fallback))
                    } else {
                        self.showOffline(reason: "Neither the tailnet address nor the local relay answers. Is Tailscale connected? Is the relay running?")
                    }
                }
            } else {
                self.showOffline(reason: "The server does not answer.")
            }
        }
    }

    private func escapedHTML(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    func showOffline(title: String? = nil, reason: String, url: URL? = nil, autoRetry: Bool = true) {
        let title = title ?? "\(config.name) is unreachable"
        showingOfflinePage = true
        retryTimer?.invalidate()
        let address = escapedHTML((url ?? webView.url ?? remoteURL).absoluteString)
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(escapedHTML(config.name))</title>
        <style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#fafafa;color:#222}
        @media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#e5e5e7}}main{width:min(38em,calc(100% - 3em));padding:2.5em;text-align:center}h1{font-size:1.45em;font-weight:650;margin:0 0 .6em}
        p{color:#666;margin:.7em 0}@media (prefers-color-scheme:dark){p{color:#a1a1a6}}code{display:block;font:.88em ui-monospace,Menlo,monospace;overflow-wrap:anywhere;padding:.7em 1em;border-radius:8px;background:#8881}
        button{font:600 1.05em -apple-system,system-ui,sans-serif;padding:.75em 1.6em;margin-top:.7em;border-radius:10px;border:0;background:#0a84ff;color:#fff;cursor:pointer;box-shadow:0 1px 4px #0003}button:active{transform:translateY(1px)}</style></head>
        <body><main><h1>\(escapedHTML(title))</h1><p>\(escapedHTML(reason))</p><p><code>\(address)</code></p>
        <p><button autofocus onclick="this.disabled=true;this.textContent='Reconnecting…';webkit.messageHandlers.deepseaApp.postMessage('retry')">Reconnect</button></p>
        \(autoRetry ? "<p style=\"font-size:.9em\">Retrying automatically every 5 seconds.</p>" : "")</main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
        if autoRetry {
            retryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in self?.connect() }
        }
    }

    /// This run's log, `app/<ts>-<pid>.log` in the variant's log directory, its first line naming the run (Paths.swift).
    lazy var logURL: URL = {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return AppPaths.openRunLog(identity: "\(AppPaths.variantName) app pid \(getpid()) \(config.name) \(version) (\(build))")
    }()
    func appendLog(_ line: String) {
        let text = "\(AppPaths.iso(Date())) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: logURL) { defer { try? handle.close() }; _ = try? handle.seekToEnd(); handle.write(Data(text.utf8)) }
        else { try? text.write(to: logURL, atomically: true, encoding: .utf8) }
    }

    /// One-shot hint for the next file picker, posted by the page just before it
    /// opens an <input type=file> (`webkit.messageHandlers.deepseaApp.postMessage(
    /// {type: "open-panel", directory: "~/.pi/agent", message: "…", showsHiddenFiles: true})`).
    /// A web page cannot choose where a picker starts; the wrapper can. Consumed
    /// by the next runOpenPanel or dropped after 10 s.
    private var openPanelHint: (directory: URL?, message: String?, showsHiddenFiles: Bool, expires: Date)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "deepseaApp" else { return }
        if (message.body as? String) == "retry" { connect(); return }
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "console" {
            appendLog("[\(body["level"] as? String ?? "log")] \(body["text"] as? String ?? "")")
            return
        }
        // Popup windows share the user scripts; only the main page steers the main window.
        if body["type"] as? String == "titlebar" {
            if message.webView === webView { titlebarMouseDown(clicks: body["clicks"] as? Int ?? 1) }
            return
        }
        if body["type"] as? String == "dragRegions" {
            guard message.webView === webView, let rows = body["rects"] as? [[Double]] else { return }
            webView.dragRegions = rows.compactMap { $0.count == 4 ? NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
            return
        }
        if body["type"] as? String == "theme" {
            if message.webView === webView { applyPageTheme(body["value"] as? String ?? "system") }
            return
        }
        if body["type"] as? String == "set-frame" {
            if message.webView === webView { applyRequestedFrame(body["frame"]) }
            return
        }
        if body["type"] as? String == "open-url" {
            // Only web and mail URLs, like a page-initiated popup out of scope; a loopback URL is
            // forwarded first (the remote's loopback), the same as for target=_blank.
            guard let raw = body["url"] as? String, let url = URL(string: raw),
                  ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
            appendLog("[open-url] \(url.absoluteString)")
            if serverIsRemote, !scope.contains(url), let link = LoopbackLink(url) {
                forwardLoopback(link) { [weak self] target in
                    guard let self, let target else { return }
                    if self.scope.contains(target) { self.openPopupWindow(target) } else { openExternally(target) }
                }
                return
            }
            if scope.contains(url) { openPopupWindow(url) } else { openExternally(url) }
            return
        }
        if body["type"] as? String == "window-info" {
            if message.webView === webView { publishWindowInfo() }
            return
        }
        guard body["type"] as? String == "open-panel" else { return }
        var directory: URL?
        // `file` wins when it exists: NSOpenPanel opens the containing folder with
        // that file selected when directoryURL names a file (long-standing AppKit
        // behaviour, not documented — hence the directory fallback).
        if let raw = body["file"] as? String, !raw.isEmpty {
            let expanded = NSString(string: raw).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir), !isDir.boolValue { directory = URL(fileURLWithPath: expanded) }
        }
        if directory == nil, let raw = body["directory"] as? String, !raw.isEmpty {
            let expanded = NSString(string: raw).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: expanded, isDirectory: &isDir), isDir.boolValue { directory = URL(fileURLWithPath: expanded) }
        }
        openPanelHint = (directory, body["message"] as? String, body["showsHiddenFiles"] as? Bool ?? false, Date().addingTimeInterval(10))
    }

    // MARK: navigation

    /// URLs a test build was asked to open outside the app (the automation's `opened`).
    var externalOpens: [String] = []
    /// A main-frame URL the automation asked this window to load: it, and the redirects and
    /// script navigations on its origin until that load finishes (a token exchange answering
    /// 303 to the bare URL, say), are exempt from the scope rule. A clicked link never is.
    var automationLoad: URL?

    /// Whether a main-frame navigation belongs to the automation's load in progress.
    private func partOfAutomationLoad(_ navigationAction: WKNavigationAction, _ url: URL) -> Bool {
        guard let requested = automationLoad, navigationAction.targetFrame?.isMainFrame ?? true else { return false }
        if url == requested { return true }
        guard navigationAction.navigationType != .linkActivated, navigationAction.navigationType != .formSubmitted else { return false }
        return url.scheme?.lowercased() == requested.scheme?.lowercased() && url.host?.lowercased() == requested.host?.lowercased() && url.port == requested.port
    }

    /// Whether this is an agent's invisible test build, which never opens anything outside itself.
    var holdsExternalOpens: Bool { options.automation != nil && options.hidden }

    /// Open a URL outside the app: the default browser, or the app that handles it. A hidden test
    /// build (`--automation --hidden`) never does: it logs the URL and keeps it for the automation's
    /// `opened`, so an agent's test cannot open windows in the person's own browser. A visible test
    /// build is someone trying the app: it opens as the real app does, and still records the URL.
    func openExternally(_ url: URL) {
        if options.automation != nil { externalOpens.append(url.absoluteString) }
        if holdsExternalOpens {
            appendLog("external (not opened, hidden test build): \(url.absoluteString)")
            return
        }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { decisionHandler(.allow); return }
        if partOfAutomationLoad(navigationAction, url) {
            decisionHandler(.allow)
            return
        }
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        // A loopback URL outside our own entry points names the remote's loopback:
        // forward the port first, then let the load proceed (an iframe such as the
        // GUI's Sidebar Browser) or hand a top-level navigation to the default
        // browser like any other foreign link — the tunnel stays up either way.
        if serverIsRemote, !scope.contains(url), let link = LoopbackLink(url) {
            forwardLoopback(link) { [weak self] target in
                guard let self else { decisionHandler(.cancel); return }
                guard let target else { decisionHandler(.cancel); return }
                if self.scope.contains(target) {
                    // The server's own port → this app: main frame loads it here, a subframe gets a window.
                    if isMainFrame { webView.load(URLRequest(url: target)) } else { self.openPopupWindow(target) }
                    decisionHandler(.cancel)
                } else if isMainFrame {
                    openExternally(target)
                    decisionHandler(.cancel)
                } else if target == url {
                    decisionHandler(.allow)
                } else {
                    // The subframe cannot be redirected onto the substitute local port; open it outside.
                    openExternally(target)
                    decisionHandler(.cancel)
                }
            }
            return
        }
        // Only user-initiated top-level navigations are subject to the scope rule;
        // redirects and in-scope loads (including the token exchange) pass.
        if isMainFrame && !scope.contains(url) {
            if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil || navigationAction.navigationType == .other {
                if url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto" {
                    openExternally(url)
                    decisionHandler(.cancel)
                    return
                }
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // The relay's own answers (x-deepsea-relay: starting | failed | no-proxy) are pages to show:
        // "starting" reloads itself once the server answers (apps/relay).
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse,
           !(200...399).contains(http.statusCode), http.value(forHTTPHeaderField: "x-deepsea-relay") == nil {
            let url = http.url ?? webView.url ?? remoteURL
            let phrase = HTTPURLResponse.localizedString(forStatusCode: http.statusCode).capitalized
            appendLog("[navigation] HTTP \(http.statusCode) \(phrase): \(url.absoluteString)")
            // 421 at the tailnet address: the variant does not serve that name (yet); its local
            // relay serves it regardless, so go there instead of showing an error.
            if http.statusCode == 421, url.host == remoteURL.host, url.port == remoteURL.port, let fallback = fallbackURL() {
                decisionHandler(.cancel)
                appendLog("[navigation] the tailnet address refused this variant; loading the local relay")
                DispatchQueue.main.async { [weak self] in
                    self?.showingOfflinePage = false
                    self?.webView.load(URLRequest(url: fallback))
                }
                return
            }
            decisionHandler(.cancel)
            DispatchQueue.main.async { [weak self] in
                self?.showOffline(
                    title: "\(self?.config.name ?? "DeepSea") failed to load",
                    reason: "The server returned HTTP \(http.statusCode) \(phrase).",
                    url: url,
                    autoRetry: false)
            }
            return
        }
        if navigationResponse.isForMainFrame, !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        if let http = navigationResponse.response as? HTTPURLResponse, navigationResponse.isForMainFrame,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition"), disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return } // frame load interrupted (download)
        if webView === self.webView { automationLoad = nil }
        automation?.navigationFailed(nsError.localizedDescription)
        showOffline(reason: nsError.localizedDescription)
    }

    /// Secondary windows opened by the page (window.open / target=_blank on an in-scope URL, e.g. a
    /// an inline plot image at full size). Each is its own WKWebView sharing this app's data store
    /// (cookies), so the request is admitted like the main page. Kept alive here; removed on close.
    private var popups: [NSWindow] = []

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        // A loopback URL (target=_blank link, "Open in system browser" from the GUI's
        // Browser tab): forward the port, then open it in the default browser — the
        // user's real browser is the better host for a dev server than a wrapper window.
        if serverIsRemote, !scope.contains(url), let link = LoopbackLink(url) {
            forwardLoopback(link) { [weak self] target in
                guard let self, let target else { return }
                if self.scope.contains(target) { self.openPopupWindow(target) } else { openExternally(target) }
            }
            return nil
        }
        // Out of scope → the default browser, as before.
        guard scope.contains(url) else { openExternally(url); return nil }
        // In scope → a real second window. (Until 2026-09-22 this loaded the URL into the MAIN
        // window: clicking an inline image replaced the whole GUI with the bare image, and
        // the red button then closed the app's only window.) WebKit requires the returned view to
        // be created with the configuration it hands us.
        return makePopup(configuration: configuration, title: url.lastPathComponent)
    }

    /// A second window of ours for an in-scope URL we choose to load (not a page-initiated popup).
    private func openPopupWindow(_ url: URL) {
        let popup = makePopup(configuration: webView.configuration.copy() as! WKWebViewConfiguration, title: url.lastPathComponent)
        popup.load(URLRequest(url: url))
    }

    private func makePopup(configuration: WKWebViewConfiguration, title: String) -> WKWebView {
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = self
        popup.uiDelegate = self
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 720),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = title.isEmpty ? config.name : title
        w.contentView = popup
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.center()
        if let main = window { w.setFrameOrigin(NSPoint(x: main.frame.midX - 480, y: main.frame.midY - 360)) }
        popups.append(w)
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { [weak self] _ in
            self?.popups.removeAll { $0 === w }
        }
        w.makeKeyAndOrderFront(nil)
        return popup
    }

    // MARK: loopback forwarding

    /// Forward the remote port a loopback link names, then call back with the URL to
    /// use here: the link itself when the same local port could be bound, a rewritten
    /// one when it could not, this app's own mount when the port is the remote server
    /// instance itself, or nil when the remote refused (an alert says why).
    func forwardLoopback(_ link: LoopbackLink, completion: @escaping (URL?) -> Void) {
        forwarder.ensure(remotePort: link.port) { [weak self] result in
            guard let self else { completion(nil); return }
            switch result {
            case .success(let listener):
                completion(link.rewritten(toLocalPort: listener.localPort))
            case .failure(let error):
                if error.refusalCode == "reserved", let base = self.currentMountBase() {
                    // `$DSH_WEB_URL`-style links (http://127.0.0.1:<server port>/...) mean this very GUI.
                    var relative = link.url.path.isEmpty ? "" : String(link.url.path.dropFirst())
                    if let query = link.url.query { relative += "?\(query)" }
                    completion(URL(string: relative, relativeTo: base)?.absoluteURL ?? base)
                    return
                }
                self.reportForwardFailure(port: link.port, error: error)
                completion(nil)
            }
        }
    }

    private func reportForwardFailure(port: Int, error: ForwardError) {
        appendLog("forward: \(port): \(error)")
        let now = Date()
        if let last = lastForwardAlert[port], now.timeIntervalSince(last) < 30 { return }
        lastForwardAlert[port] = now
        let alert = NSAlert()
        alert.messageText = "Cannot open 127.0.0.1:\(port) on the server's machine"
        alert.informativeText = "\(error)"
        alert.addButton(withTitle: "OK")
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    @objc func closeForward(_ sender: NSMenuItem) {
        guard let port = sender.representedObject as? Int else { return }
        forwarder.close(remotePort: port)
    }

    @objc func closeAllForwards() { forwarder.closeAll() }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === forwardedPortsMenu else { return }
        menu.removeAllItems()
        let rows = forwarder.rows
        if rows.isEmpty {
            let none = menu.addItem(withTitle: "No forwarded ports", action: nil, keyEquivalent: "")
            none.isEnabled = false
            return
        }
        for row in rows {
            let label = row.localPort == row.remotePort
                ? "127.0.0.1:\(row.remotePort)"
                : "127.0.0.1:\(row.localPort) → remote :\(row.remotePort)"
            let suffix = row.connections == 0 ? "" : "  (\(row.connections) connection\(row.connections == 1 ? "" : "s"))"
            let item = menu.addItem(withTitle: "Close \(label)\(suffix)", action: #selector(closeForward(_:)), keyEquivalent: "")
            item.representedObject = row.remotePort
            item.target = self
        }
        menu.addItem(.separator())
        let all = menu.addItem(withTitle: "Close All", action: #selector(closeAllForwards), keyEquivalent: "")
        all.target = self
    }

    /// `window.close()` from a popup page.
    func webViewDidClose(_ webView: WKWebView) {
        if let w = popups.first(where: { $0.contentView === webView }) { w.close() }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let hint = openPanelHint, hint.expires > Date() {
            if let directory = hint.directory { panel.directoryURL = directory }
            if let text = hint.message { panel.message = text }
            panel.showsHiddenFiles = hint.showsHiddenFiles
        }
        openPanelHint = nil
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: downloads

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
        appendLog("download: from a response, \(navigationResponse.response.url?.absoluteString ?? "?")")
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
        appendLog("download: from a link, \(navigationAction.request.url?.absoluteString ?? "?")")
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloads = options.downloads.map { URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath, isDirectory: true) }
            ?? FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        try? FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        var target = downloads.appendingPathComponent(suggestedFilename)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var counter = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = downloads.appendingPathComponent(ext.isEmpty ? "\(stem) \(counter)" : "\(stem) \(counter).\(ext)")
            counter += 1
        }
        appendLog("download: saving to \(target.path)")
        automation?.navigationDownloaded(target.path)
        completionHandler(target)
    }

    func downloadDidFinish(_ download: WKDownload) {
        DistributedNotificationCenter.default().post(name: NSNotification.Name("com.apple.DownloadFileFinished"), object: nil)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.messageText = "Download failed"
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }

    // MARK: menu

    /// Toggle the GUI's Settings panel from the page side. Two layers:
    ///  1. the settings-shortcut plugin, when loaded, owns the toggle — dispatch its ⌘. chord as a
    ///     synthetic `keydown` on `window` (its capture listener `preventDefault`s → dispatchEvent returns false);
    ///  2. otherwise click the sidebar's Settings trigger, or the open panel's close button (the shell keeps
    ///     the open state as component-local React state; the DOM is the only seam — same selectors as the
    ///     plugin, `[hash]_[local]` CSS-module classes make the `_suffix` stable across rebuilds).
    static let toggleSettingsScript = """
    (() => {
      const chord = new KeyboardEvent('keydown', { key: '.', code: 'Period', metaKey: true, bubbles: true, cancelable: true });
      if (!window.dispatchEvent(chord)) return 'plugin';
      const trigger = document.querySelector('[class$="_settingsArea"] button[aria-haspopup="dialog"]')
        || document.querySelector('button[aria-haspopup="dialog"][class*="_trigger"]');
      if (!trigger) return 'no-trigger';
      if (trigger.getAttribute('aria-expanded') === 'true') {
        const close = document.querySelector('[role="dialog"][class$="_panel"] button[class$="_close"]');
        if (!close) return 'no-close';
        close.click();
        return 'closed';
      }
      trigger.click();
      return 'opened';
    })()
    """

    @objc func openSettings() {
        if showingOfflinePage { NSSound.beep(); return }
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript(AppDelegate.toggleSettingsScript) { [weak self] result, error in
            let outcome = (result as? String) ?? (error.map { "error: \($0.localizedDescription)" } ?? "unknown")
            self?.appendLog("settings: \(outcome)")
            if outcome == "no-trigger" || outcome == "no-close" { NSSound.beep() }
        }
    }

    @objc func reload() { if showingOfflinePage { connect() } else { webView.reloadFromOrigin() } }
    @objc func openInBrowser() { openExternally(webView.url.flatMap { scope.contains($0) ? $0 : nil } ?? remoteURL) }
    @objc func copyURL() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString((webView.url ?? remoteURL).absoluteString, forType: .string)
    }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 3) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
    @objc func zoomReset() { webView.pageZoom = 1 }
    @objc func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: config.name,
            .credits: NSAttributedString(string: config.url),
        ])
    }

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About \(config.name)", action: #selector(showAbout), keyEquivalent: "")
        app.addItem(.separator())
        // The standard macOS chord. Safari cannot give ⌘, to a page (it is Safari's own Settings…);
        // here the menu bar is ours, so it drives the GUI's Settings panel instead.
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(config.name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(config.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Reconnect", action: #selector(connect), keyEquivalent: "")
        view.addItem(.separator())
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(.separator())
        desktopMenuItem = view.addItem(withTitle: "Desktop", action: #selector(selectDesktopView), keyEquivalent: "")
        mobileMenuItem = view.addItem(withTitle: "Mobile", action: #selector(selectMobileView), keyEquivalent: "")
        syncViewModeMenu()
        view.addItem(.separator())
        let materialItem = view.addItem(withTitle: "Window Material", action: nil, keyEquivalent: "")
        let material = NSMenu(title: "Window Material")
        material.autoenablesItems = false
        frostedMenuItem = material.addItem(withTitle: "Frosted", action: #selector(selectFrostedMaterial), keyEquivalent: "")
        frostedMenuItem.target = self
        liquidGlassMenuItem = material.addItem(withTitle: "Liquid Glass", action: #selector(selectLiquidGlassMaterial), keyEquivalent: "")
        liquidGlassMenuItem.target = self
        materialItem.submenu = material
        syncWindowMaterialMenu()
        view.addItem(.separator())
        let openInBrowser = view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        openInBrowser.keyEquivalentModifierMask = [.command, .shift]
        let copy = view.addItem(withTitle: "Copy Address", action: #selector(copyURL), keyEquivalent: "c")
        copy.keyEquivalentModifierMask = [.command, .shift]
        view.addItem(.separator())
        let forwards = view.addItem(withTitle: "Forwarded Ports", action: nil, keyEquivalent: "")
        forwardedPortsMenu.delegate = self
        forwardedPortsMenu.autoenablesItems = false
        forwards.submenu = forwardedPortsMenu
        view.addItem(.separator())
        view.addItem(withTitle: "Save Window Snapshot", action: #selector(saveWindowSnapshot), keyEquivalent: "")
        view.addItem(withTitle: "Copy Window Snapshot", action: #selector(copyWindowSnapshot), keyEquivalent: "")
        view.addItem(withTitle: "Save Element Snapshot", action: #selector(saveElementSnapshot), keyEquivalent: "")
        view.addItem(withTitle: "Copy Element Snapshot", action: #selector(copyElementSnapshot), keyEquivalent: "")
        view.addItem(.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
