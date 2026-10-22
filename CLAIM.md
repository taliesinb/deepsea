# CLAIM

Porting claims against the old `taliesinb/dsh-plugins` PR set. One agent per
line; append, do not edit others' lines. Remove a line when its port has
landed (or been found unnecessary) and say so in the PR / topic.

| dsh-plugins PR | what | claimed by | target | status |
|---|---|---|---|---|
| #2 brand-kit, #4 brand profiles UI + CLI | re-brand the web GUI from profiles | agent "dock-app-fixes" (session 2026-10-22) | — | **already in deepsea** as `plugins/brand-kit` on `topic/branding` (profiles.mjs, cli.mjs, profiles-card.tsx; row config retired → `SHIPPED_LOOK`). Nothing to port. |
| #1 dock-app integrated title bar | traffic lights in the strip, frosted / Liquid Glass material, drag bridge | same | — | **already in deepsea** (`apps/macos/Sources/main.swift`: `layoutTrafficLights`, `installBackdrop`, `WindowMaterial`, `titlebarBridgeScript`). Nothing to port. |
| #8 window material survives a cold launch | rebuild the backdrop once the window is on screen; non-opaque window; glass as a layer under the page | same | `deepsea` `topic/macos-app` | **not in deepsea** — launch still calls `installBackdrop()` before `makeKeyAndOrderFront`, window never made non-opaque, glass hosts the web view. Porting. |
| #12 guaranteed title-bar drag | native drag regions (page-reported hit-tested map, `DockWebView.mouseDown` consumes presses; click-or-drag on soft triggers) | same | `deepsea` `topic/macos-app` | **not in deepsea** — still the mousedown→postMessage→`performDrag(NSApp.currentEvent)` bridge that was fickle. Porting. |
