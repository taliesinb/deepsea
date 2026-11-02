// View ▸ Save / Copy Window Snapshot and Save / Copy Element Snapshot, and the
// same captures for the automation channel (Automation.swift).
//
// Window: the main window, title bar included, via CGWindowListCreateImage (a
// process may capture its own windows without Screen Recording permission), or
// the page alone via WKWebView.takeSnapshot (which also works for a hidden test
// window). Save stores the PNG in images/<sha256>.png and links
// snapshots/window-<ts>-<pid>.png to it (Paths.swift); Copy puts it on the
// clipboard. The window material shows as a flat fill in the capture.
//
// Element: the menu commands run the page-side picker from element-inspector.js
// (bundled; `DEEPSEA_ELEMENT_INSPECTOR=<path>` or the `deepsea.elementInspectorScript`
// default overrides it for development): hover highlights, click or Enter picks,
// Escape cancels, ↑/↓ walk to the parent and back. The automation channel names
// the element instead (`describe`). Either way, Save writes
// snapshots/element-<ts>-<pid>/; its PNGs are links into the content-addressed
// store, recorded with their hashes under `images` in the JSON:
//   element.png   the element's on-screen part plus the inspector's `margin`
//                 (15 CSS px; transparent past the window), as WebKit renders it
//   window.png    the whole page with the element outlined
//   cursor.png    64×64 points centred on the pointer at a pick (picks only)
//   element.json  the inspector record plus this process's own facts (`native`)
//   element.md    a short summary for an agent, pointing at the other files
// Copy puts element.png on the clipboard only. Saves from the menu open their
// PNGs in Preview; `kill -USR1 <pid>` (window) and `kill -USR2 <pid>` (element;
// the user still picks) save without opening anything.

import Cocoa
import WebKit

extension AppDelegate {
    static let inspectorOverrideKey = "deepsea.elementInspectorScript"

    /// The inspector source and where it came from (override path or the bundle resource).
    func elementInspectorSource() -> (source: String, origin: String)? {
        let candidates = [ProcessInfo.processInfo.environment["DEEPSEA_ELEMENT_INSPECTOR"], UserDefaults.standard.string(forKey: Self.inspectorOverrideKey)]
        for candidate in candidates.compactMap({ $0 }).filter({ !$0.isEmpty }) {
            let path = NSString(string: candidate).expandingTildeInPath
            if let text = try? String(contentsOfFile: path, encoding: .utf8) { return (text, path) }
            appendLog("element snapshot: cannot read inspector override \(path); using the bundled copy")
        }
        guard let url = Bundle.main.url(forResource: "element-inspector", withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return (text, url.path)
    }

    /// Install the inspector in the page (re-evaluated every time, so an edited override takes effect).
    /// Completion: its origin, or nil with the reason (offline, missing, install failed).
    func installInspector(completion: @escaping (_ origin: String?, _ failure: String?) -> Void) {
        guard !showingOfflinePage else { completion(nil, "offline"); return }
        guard let (source, origin) = elementInspectorSource() else {
            appendLog("element snapshot: element-inspector.js is missing from the app bundle")
            completion(nil, "no inspector")
            return
        }
        webView.evaluateJavaScript(source) { [weak self] _, error in
            if let error {
                self?.appendLog("element snapshot: installing \(origin) failed: \(error.localizedDescription)")
                completion(nil, "install failed: \(error.localizedDescription)")
                return
            }
            completion(origin, nil)
        }
    }

    /// Describe a target without a pick (a selector, `{selector, nth}` or `{x, y}`). Completion: the record
    /// (with `inspector.found`) and the inspector's origin, or nil with the reason.
    func describeElement(target: Any, options: [String: Any], completion: @escaping (_ record: [String: Any]?, _ inspector: String, _ failure: String?) -> Void) {
        installInspector { [weak self] origin, failure in
            guard let self, let origin else { completion(nil, "", failure ?? "failed"); return }
            self.webView.callAsyncJavaScript(
                "return JSON.stringify(globalThis.__DEEPSEA_INSPECT__.describe(target, options))",
                arguments: ["target": target, "options": options], in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value):
                    guard let text = value as? String, let data = text.data(using: .utf8),
                          let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        completion(nil, origin, "the inspector returned no record")
                        return
                    }
                    completion(record, origin, nil)
                case .failure(let error):
                    completion(nil, origin, "describe failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Install the inspector and run a pick. The completion gets the decoded record, or nil with the
    /// reason (cancelled, offline, failure).
    func pickElement(options: [String: Any], completion: @escaping (_ record: [String: Any]?, _ inspector: String, _ outcome: String) -> Void) {
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        installInspector { [weak self] origin, failure in
            guard let self else { return }
            guard let origin else { NSSound.beep(); completion(nil, "", failure ?? "failed"); return }
            self.webView.callAsyncJavaScript(
                "const r = await globalThis.__DEEPSEA_INSPECT__.pick(options); return r == null ? null : JSON.stringify(r)",
                arguments: ["options": options], in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value):
                    guard let text = value as? String, let data = text.data(using: .utf8),
                          let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                        completion(nil, origin, "cancelled")
                        return
                    }
                    completion(record, origin, "picked")
                case .failure(let error):
                    self.appendLog("element snapshot: pick failed: \(error.localizedDescription)")
                    completion(nil, origin, "failed")
                }
            }
        }
    }

    /// `{x, y, width, height}` in CSS px → view points (page zoom applied), clamped to the web view
    /// unless `clamp` is false (a capture box may reach past the window).
    func viewRect(fromCSS value: Any?, clamp: Bool = true) -> CGRect? {
        guard let r = value as? [String: Any],
              let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
              let w = (r["width"] as? NSNumber)?.doubleValue, let h = (r["height"] as? NSNumber)?.doubleValue else { return nil }
        let zoom = Double(webView.pageZoom)
        let full = CGRect(x: x * zoom, y: y * zoom, width: w * zoom, height: h * zoom)
        let rect = clamp ? full.intersection(webView.bounds) : full
        return rect.isNull || rect.width < 1 || rect.height < 1 ? nil : rect
    }

    /// PNG of the web view (or one rect of it) at the window's backing scale, optionally outlining `highlight`
    /// (view points, top-left origin). With `canvas`, the PNG covers exactly that rect (view points, may
    /// reach past the web view): the part inside the view is drawn at its offset, the rest stays transparent.
    /// Completion: PNG data and its pixel size, or nil.
    func webViewPNG(rect: CGRect?, highlight: CGRect? = nil, canvas: CGRect? = nil, completion: @escaping (Data?, CGSize) -> Void) {
        let cfg = WKSnapshotConfiguration()
        var source = rect
        if let canvas {
            let inside = canvas.intersection(webView.bounds)
            guard !inside.isNull, inside.width >= 1, inside.height >= 1 else { completion(nil, .zero); return }
            source = inside
        }
        if let source { cfg.rect = source }
        cfg.afterScreenUpdates = true
        let scale = window.backingScaleFactor
        webView.takeSnapshot(with: cfg) { image, error in
            guard let image else {
                self.appendLog("element snapshot: takeSnapshot failed: \(error?.localizedDescription ?? "no image")")
                completion(nil, .zero)
                return
            }
            let outSize = canvas?.size ?? image.size
            // Bottom-left origin in the bitmap; the page's coordinates are top-left.
            let drawRect = canvas.map { c in NSRect(x: source!.minX - c.minX, y: c.height - (source!.maxY - c.minY), width: source!.width, height: source!.height) }
                ?? NSRect(origin: .zero, size: image.size)
            let pxW = Int((outSize.width * scale).rounded()), pxH = Int((outSize.height * scale).rounded())
            guard pxW > 0, pxH > 0, let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pxW, pixelsHigh: pxH, bitsPerSample: 8,
                                                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
                completion(nil, .zero)
                return
            }
            rep.size = outSize
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSGraphicsContext.current?.imageInterpolation = .high
            image.draw(in: drawRect)
            if let h = highlight {
                let flipped = NSRect(x: h.minX, y: image.size.height - h.maxY, width: h.width, height: h.height).insetBy(dx: -1, dy: -1)
                let colour = NSColor(srgbRed: 10 / 255, green: 132 / 255, blue: 1, alpha: 1)
                colour.withAlphaComponent(0.15).setFill()
                flipped.fill()
                colour.setStroke()
                let path = NSBezierPath(rect: flipped)
                path.lineWidth = 3
                path.stroke()
            }
            NSGraphicsContext.restoreGraphicsState()
            completion(rep.representation(using: .png, properties: [:]), CGSize(width: pxW, height: pxH))
        }
    }

    /// The element image: the record's `rect.capture` (visible rect + the inspector's `margin`, transparent past
    /// the window), or the bare visible rect from an inspector without it. Completion: PNG, pixel size, and the
    /// facts an agent needs to read the image (kept in `snapshot.element`).
    func elementPNG(rects: [String: Any]?, completion: @escaping (Data?, CGSize, [String: Any]) -> Void) {
        guard let visible = viewRect(fromCSS: rects?["visible"]) else {
            completion(nil, .zero, ["error": "the element has no visible part on screen"])
            return
        }
        let captureCSS = rects?["capture"] as? [String: Any]
        let marginCSS = (captureCSS?["margin"] as? NSNumber)?.doubleValue ?? 0
        let canvas = viewRect(fromCSS: captureCSS, clamp: false) ?? visible
        let scale = window.backingScaleFactor
        let inImage = CGRect(x: visible.minX - canvas.minX, y: visible.minY - canvas.minY, width: visible.width, height: visible.height)
        webViewPNG(rect: nil, canvas: canvas) { png, size in
            var facts: [String: Any] = [
                "viewRect": self.rectJSON(canvas),
                "marginCSS": marginCSS,
                "marginPoints": marginCSS * Double(self.webView.pageZoom),
                "elementInImage": self.rectJSON(inImage),
                "elementInImagePixels": self.rectJSON(CGRect(x: inImage.minX * scale, y: inImage.minY * scale, width: inImage.width * scale, height: inImage.height * scale)),
                "pixelWidth": size.width, "pixelHeight": size.height,
            ]
            if png == nil { facts["error"] = "snapshot failed" }
            completion(png, size, facts)
        }
    }

    func rectJSON(_ r: CGRect) -> [String: Any] {
        ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }

    /// Facts only this process knows: which binary, which variant, which window, which server URL.
    func nativeContext(inspectorScript: String) -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let fm = FileManager.default
        var app: [String: Any] = [
            "name": config.name,
            "variant": AppPaths.variantName,
            "bundleId": Bundle.main.bundleIdentifier ?? NSNull(),
            "bundlePath": Bundle.main.bundlePath,
            "executablePath": Bundle.main.executablePath ?? NSNull(),
            "pid": Int(getpid()),
            "parentPid": Int(getppid()),
            "version": info["CFBundleShortVersionString"] ?? NSNull(),
            "launchedAt": AppPaths.iso(appLaunchDate, fraction: true),
            "hidden": options.hidden,
            "ephemeral": options.ephemeral,
            "uptimeSeconds": Int(Date().timeIntervalSince(appLaunchDate)),
            "logFile": logURL.path,
            "inspectorScript": inspectorScript,
        ]
        if let exe = Bundle.main.executablePath, let modified = (try? fm.attributesOfItem(atPath: exe))?[.modificationDate] as? Date {
            app["executableModified"] = AppPaths.iso(modified, fraction: true)
        }
        // Private WKWebView accessor: the WebContent process that renders the page (absent → omitted).
        if webView.responds(to: NSSelectorFromString("_webProcessIdentifier")), let pid = webView.value(forKey: "_webProcessIdentifier") as? NSNumber {
            app["webContentPid"] = pid
        }
        let current = webView.url
        let server: [String: Any] = [
            "configuredUrl": config.url,
            "fallbackUrl": config.fallbackUrl ?? NSNull(),
            "tokenFile": config.tokenFile ?? NSNull(),
            "currentUrl": current?.absoluteString ?? NSNull(),
            "mountBase": currentMountBase()?.absoluteString ?? NSNull(),
            "usingLoopbackFallback": ["127.0.0.1", "localhost"].contains(current?.host ?? ""),
            "offlinePage": showingOfflinePage,
        ]
        var windowInfo: [String: Any] = [
            "frame": rectJSON(window.frame),
            "contentSize": ["width": webView.bounds.width, "height": webView.bounds.height],
            "backingScaleFactor": window.backingScaleFactor,
            "isKey": window.isKeyWindow,
            "fullScreen": window.styleMask.contains(.fullScreen),
            "appearance": window.effectiveAppearance.name.rawValue,
            "viewMode": viewMode.rawValue,
            "windowMaterial": windowMaterial.rawValue,
            "pageZoom": webView.pageZoom,
            "magnification": webView.magnification,
        ]
        if let screen = window.screen {
            windowInfo["screen"] = ["name": screen.localizedName, "frame": rectJSON(screen.frame), "backingScaleFactor": screen.backingScaleFactor]
        }
        var host = [CChar](repeating: 0, count: 256)
        gethostname(&host, host.count)
        var model = [CChar](repeating: 0, count: 128)
        var size = model.count
        sysctlbyname("hw.model", &model, &size, nil, 0)
        let system: [String: Any] = [
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "arch": { () -> String in
                #if arch(arm64)
                return "arm64"
                #else
                return "x86_64"
                #endif
            }(),
            "hostName": String(cString: host),
            "model": String(cString: model),
            "user": NSUserName(),
        ]
        return ["app": app, "server": server, "window": windowInfo, "system": system]
    }

    // MARK: shared output

    /// PNG (plus TIFF, for apps that only read that) on the general pasteboard.
    func putOnPasteboard(png: Data) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setData(png, forType: .png)
        if let tiff = NSBitmapImageRep(data: png)?.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
    }

    /// Open files in Preview (the default app for each when Preview is missing).
    func openInPreview(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        if holdsExternalOpens { urls.forEach { externalOpens.append($0.absoluteString) }; return }
        guard let preview = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Preview") else {
            urls.forEach { openExternally($0) }
            return
        }
        NSWorkspace.shared.open(urls, withApplicationAt: preview, configuration: NSWorkspace.OpenConfiguration()) { [weak self] _, error in
            if let error { DispatchQueue.main.async { self?.appendLog("open in Preview: \(error.localizedDescription)") } }
        }
    }

    // MARK: window snapshot

    /// The main window, title bar included, as PNG data.
    func windowSnapshotPNG() -> Data? {
        guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]) else { return nil }
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }

    /// Store `png` in images/ and put a symlink to it at `link`; records `{ sha256, path, link }` under `key`.
    @discardableResult
    func saveImage(_ png: Data, linkAt link: URL, key: String, into images: inout [String: Any]) -> Bool {
        do {
            let (hash, stored) = try AppPaths.storeImage(png)
            try AppPaths.symlink(link, to: stored)
            images[key] = ["sha256": hash, "path": stored.path, "link": link.path, "bytes": png.count]
            return true
        } catch {
            appendLog("snapshot: storing \(link.lastPathComponent): \(error.localizedDescription)")
            return false
        }
    }

    /// Store a window PNG in images/, link snapshots/window-<ts>-<pid>.png to it and point latest-window.png
    /// there. Returns `{ file, image: { sha256, path, link, bytes }, pixelWidth, pixelHeight }`, or nil.
    @discardableResult
    func storeWindowSnapshot(_ png: Data, open: Bool) -> [String: Any]? {
        let dir = AppPaths.snapshotsDirectory
        let url = AppPaths.unique(in: dir, stem: "window-\(AppPaths.stamp(Date()))-\(getpid())", ext: "png")
        var images: [String: Any] = [:]
        guard saveImage(png, linkAt: url, key: "window", into: &images) else { return nil }
        AppPaths.pointLatest(link: dir.appendingPathComponent("latest-window.png"), to: url)
        appendLog("snapshot: \(url.path) -> \((images["window"] as? [String: Any])?["path"] ?? "?")")
        if open { openInPreview([url]) }
        let rep = NSBitmapImageRep(data: png)
        return ["file": url.path, "image": images["window"] ?? NSNull(), "pixelWidth": rep?.pixelsWide ?? 0, "pixelHeight": rep?.pixelsHigh ?? 0]
    }

    /// The menu's and USR1's window snapshot: the whole window, title bar included.
    func writeWindowSnapshot(openInPreview open: Bool) {
        guard let png = windowSnapshotPNG(), storeWindowSnapshot(png, open: open) != nil else {
            appendLog("snapshot: capture failed")
            NSSound.beep()
            return
        }
    }

    @objc func saveWindowSnapshot() { writeWindowSnapshot(openInPreview: true) }

    @objc func copyWindowSnapshot() {
        guard let png = windowSnapshotPNG() else {
            appendLog("copy window snapshot: capture failed")
            NSSound.beep()
            return
        }
        putOnPasteboard(png: png)
        appendLog("copy window snapshot: \(png.count) bytes on the clipboard")
        NSSound(named: "Tink")?.play()
    }

    // MARK: element snapshot

    /// cursor.png reaches this far (view points) from the pointer in every direction; the pointer is its exact centre.
    static let cursorSnapshotRadius: CGFloat = 32

    /// Where the pointer was at a pick, in view points: the page's own record (the click point, or the last
    /// hover position for an Enter pick), else the native pointer location now. Nil for a described element.
    func pickPointer(_ record: [String: Any]) -> (CGPoint, String)? {
        guard record["pick"] != nil else { return nil }
        let zoom = webView.pageZoom
        if let pointer = (record["pick"] as? [String: Any])?["pointer"] as? [String: Any],
           let x = (pointer["x"] as? NSNumber)?.doubleValue, let y = (pointer["y"] as? NSNumber)?.doubleValue {
            return (CGPoint(x: x * zoom, y: y * zoom), "page")
        }
        let local = webView.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        let point = webView.isFlipped ? local : CGPoint(x: local.x, y: webView.bounds.height - local.y)
        return webView.bounds.contains(point) ? (point, "native") : nil
    }

    @objc func saveElementSnapshot() { runSaveElementSnapshot(openInPreview: true) }

    func runSaveElementSnapshot(openInPreview open: Bool) {
        pickElement(options: [:]) { [weak self] picked, inspector, outcome in
            guard let self else { return }
            guard let record = picked else { self.appendLog("element snapshot: \(outcome)"); return }
            self.captureElementSnapshot(record: record, inspector: inspector, open: open) { result in
                if result == nil { NSSound.beep() }
            }
        }
    }

    /// Write snapshots/element-<ts>-<pid>/ for an inspector record (picked or described). Completion: the
    /// final record (with `files`, `images`, `snapshot`, `native`), or nil when the folder could not be made.
    func captureElementSnapshot(record picked: [String: Any], inspector: String, open: Bool, completion: @escaping ([String: Any]?) -> Void) {
        var record = picked
        let captured = Date()
        let dir = AppPaths.unique(in: AppPaths.snapshotsDirectory, stem: "element-\(AppPaths.stamp(captured))-\(getpid())")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            appendLog("element snapshot: \(error.localizedDescription)")
            completion(nil)
            return
        }
        let element = record["element"] as? [String: Any]
        let rects = element?["rect"] as? [String: Any]
        let visible = viewRect(fromCSS: rects?["visible"])
        let box = viewRect(fromCSS: rects?["box"])
        let jsonURL = dir.appendingPathComponent("element.json")
        let mdURL = dir.appendingPathComponent("element.md")
        let elementURL = dir.appendingPathComponent("element.png")
        let windowURL = dir.appendingPathComponent("window.png")
        let cursorURL = dir.appendingPathComponent("cursor.png")
        let cursor = pickPointer(record)
        let radius = Self.cursorSnapshotRadius
        var snapshot: [String: Any] = ["pageZoom": webView.pageZoom, "backingScaleFactor": window.backingScaleFactor]
        var files: [String: Any] = ["directory": dir.path, "json": jsonURL.path, "markdown": mdURL.path]
        var images: [String: Any] = [:]

        let finish = {
            record["kind"] = "deepsea.element-snapshot"
            record["capturedAt"] = AppPaths.iso(captured, fraction: true)
            record["native"] = self.nativeContext(inspectorScript: inspector)
            record["snapshot"] = snapshot
            record["files"] = files
            record["images"] = images
            let json = (try? JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
            try? json.write(to: jsonURL)
            self.webView.callAsyncJavaScript(
                "return globalThis.__DEEPSEA_INSPECT__.markdown(JSON.parse(json))",
                arguments: ["json": String(decoding: json, as: UTF8.self)], in: nil, in: .page
            ) { result in
                let text: String
                if case .success(let value) = result, let md = value as? String { text = md }
                else { text = "# Element snapshot\n\nThe page could not write the summary; see \(jsonURL.path).\n" }
                try? text.write(to: mdURL, atomically: true, encoding: .utf8)
                AppPaths.pointLatest(link: dir.deletingLastPathComponent().appendingPathComponent("latest-element"), to: dir)
                self.appendLog("element snapshot: \(dir.path)")
                if open {
                    self.openInPreview([elementURL, windowURL, cursorURL].filter { FileManager.default.fileExists(atPath: $0.path) })
                } else if !self.options.hidden {
                    NSSound(named: "Tink")?.play()
                }
                completion(record)
            }
        }

        elementPNG(rects: rects) { png, _, facts in
            snapshot["element"] = facts
            if let png, self.saveImage(png, linkAt: elementURL, key: "element", into: &images) { files["elementPng"] = elementURL.path }
            self.webViewPNG(rect: nil, highlight: box ?? visible) { png, size in
                if let png, self.saveImage(png, linkAt: windowURL, key: "window", into: &images) {
                    files["windowPng"] = windowURL.path
                    snapshot["window"] = ["highlightViewRect": ((box ?? visible).map(self.rectJSON) as Any?) ?? NSNull(), "pixelWidth": size.width, "pixelHeight": size.height]
                }
                guard let (point, source) = cursor else { finish(); return }
                let canvas = CGRect(x: point.x - radius, y: point.y - radius, width: 2 * radius, height: 2 * radius)
                self.webViewPNG(rect: nil, canvas: canvas) { png, size in
                    if let png, self.saveImage(png, linkAt: cursorURL, key: "cursor", into: &images) {
                        files["cursorPng"] = cursorURL.path
                        snapshot["cursor"] = ["viewPoint": ["x": point.x, "y": point.y], "source": source, "radiusPoints": radius,
                                              "viewRect": self.rectJSON(canvas), "pixelWidth": size.width, "pixelHeight": size.height]
                    }
                    finish()
                }
            }
        }
    }

    @objc func copyElementSnapshot() {
        pickElement(options: ["sections": ["rect"]]) { [weak self] picked, _, outcome in
            guard let self else { return }
            guard let record = picked else { self.appendLog("copy element snapshot: \(outcome)"); return }
            let rects = (record["element"] as? [String: Any])?["rect"] as? [String: Any]
            self.elementPNG(rects: rects) { png, size, facts in
                guard let png else {
                    self.appendLog("copy element snapshot: \(facts["error"] ?? "failed")")
                    NSSound.beep()
                    return
                }
                self.putOnPasteboard(png: png)
                self.appendLog("copy element snapshot: \(Int(size.width))×\(Int(size.height)) px (margin \(facts["marginCSS"] ?? 0) CSS px) on the clipboard")
                NSSound(named: "Tink")?.play()
            }
        }
    }
}
