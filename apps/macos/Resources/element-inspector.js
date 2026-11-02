// Element inspector for the native DeepSea apps: installs `globalThis.__DEEPSEA_INSPECT__`
// in the page. Evaluated as a whole script (re-evaluating replaces the installed
// copy and cancels a pick in progress). Host-neutral: the macOS app drives it from
// View ▸ Save / Copy Element Snapshot and from its automation channel (`describe`,
// `snapshot`).
//
//   __DEEPSEA_INSPECT__.describe(target, options) → record (synchronous)
//       target: an Element, a CSS selector, { selector, nth }, or { x, y } (viewport CSS px)
//   __DEEPSEA_INSPECT__.pick(options) → Promise<record | null>
//       crosshair pick: hover highlights, click or Enter commits, Escape cancels,
//       ↑ / ↓ walk to the parent / back toward the hovered element; the record
//       gains `pick: { via: 'click'|'enter', levelsUp, pointer: {x, y} | null }`
//   __DEEPSEA_INSPECT__.cancel()            ends a pick (resolves null)
//   __DEEPSEA_INSPECT__.picking             true while a pick is active
//   __DEEPSEA_INSPECT__.markdown(record)    agent-readable summary of a record
//   __DEEPSEA_INSPECT__.defaults            the option defaults
//
// A record is JSON-safe: { inspector, page, element } (sections as selected by
// `options.sections`). Every section is collected independently: a section that
// throws (a React or slot layout this script does not know) is reported under
// `inspector.errors[<section>]` and the rest of the record is still returned.
(() => {
  const VERSION = 1

  const prior = globalThis.__DEEPSEA_INSPECT__
  try { if (prior && typeof prior.cancel === 'function') prior.cancel() } catch (error) { /* a broken earlier copy must not block reinstalling */ }

  const DEFAULTS = Object.freeze({
    sections: ['selector', 'rect', 'text', 'html', 'accessibility', 'styles', 'slots', 'react', 'ancestors', 'children', 'scroll', 'form', 'page'],
    textChars: 2000,
    htmlChars: 6000,
    ancestors: 16,
    children: 25,
    reactDepth: 40,
    reactProps: 4,
    propKeys: 30,
    propChars: 160,
    styles: [
      'display', 'position', 'box-sizing', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
      'margin', 'padding', 'border', 'border-radius', 'outline', 'overflow-x', 'overflow-y', 'z-index', 'opacity', 'visibility',
      'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
      'text-align', 'text-overflow', 'white-space', 'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
      'grid-template-columns', 'grid-template-rows', 'transform', 'transition', 'box-shadow', 'cursor', 'pointer-events',
      'content-visibility', 'contain',
    ],
    customProperties: false,
    customPropertyLimit: 80,
    highlight: '#0a84ff',
    // CSS px added on every side of the visible rect for `rect.capture` (what a host renders as the element
    // image), so borders, shadows and focus rings just outside the element show. 0 = the bare visible rect.
    margin: 15,
  })

  const resolveOptions = (options) => {
    const o = Object.assign({}, DEFAULTS, options && typeof options === 'object' ? options : {})
    if (!Array.isArray(o.sections)) o.sections = DEFAULTS.sections.slice()
    if (!Array.isArray(o.styles)) o.styles = DEFAULTS.styles.slice()
    if (typeof o.margin !== 'number' || !(o.margin >= 0)) o.margin = DEFAULTS.margin
    return o
  }

  // ---------- small helpers ----------

  const round = (v) => Math.round(v * 100) / 100
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s)
  const rectJSON = (r) => (r ? { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) } : null)
  const isElement = (v) => !!v && typeof v === 'object' && v.nodeType === 1
  const errorText = (e) => String((e && (e.message || e)) || 'error')

  function cssEscape(s) {
    if (globalThis.CSS && typeof CSS.escape === 'function') return CSS.escape(s)
    return String(s).replace(/[^\w-]/g, (c) => `\\${c}`)
  }
  const attrSelector = (name, value) => (value === '' ? `[${name}]` : `[${name}="${String(value).replace(/["\\]/g, '\\$&')}"]`)
  const count = (selector) => { try { return document.querySelectorAll(selector).length } catch (error) { return -1 } }

  /** JSON-safe copy with depth/size limits (page globals may hold anything). */
  function safeJSON(value, depth = 3, seen = new WeakSet()) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'string') return clip(value, 400)
    if (typeof value === 'undefined') return undefined
    if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}`
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[circular]'
    if (depth <= 0) return Array.isArray(value) ? `Array(${value.length})` : '{…}'
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => safeJSON(v, depth - 1, seen))
    const out = {}
    for (const key of Object.keys(value).slice(0, 50)) {
      try { out[key] = safeJSON(value[key], depth - 1, seen) } catch (error) { out[key] = `[unreadable: ${errorText(error)}]` }
    }
    return out
  }

  // CSS-module classes: the shipped client compiles to `<hash>_<local>` (6-char hash, `_`-prefixed when it
  // starts with a digit); Vite-built plugins use `_<local>_<hash>_<line>`. `local` survives rebuilds, the hash does not.
  const HASH_LOCAL = /^_?[A-Za-z0-9_-]{6}_([A-Za-z][A-Za-z0-9-]*)$/
  const VITE_LOCAL = /^_([A-Za-z][A-Za-z0-9-]*)_[a-z0-9]{5}_\d+$/
  function classInfo(el) {
    const raw = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : Array.from(el.classList || [])
    const local = []
    const plain = []
    for (const c of raw) {
      const m = VITE_LOCAL.exec(c)
      if (m) { local.push({ local: m[1], form: 'vite' }); continue }
      const n = HASH_LOCAL.exec(c)
      if (n) local.push({ local: n[1], form: 'hash' })
      else plain.push(c)
    }
    return { raw, local, plain }
  }
  const localClassSelector = ({ local, form }) => (form === 'vite'
    ? `[class*="_${local}_"]`
    : `:is([class$="_${local}"],[class*="_${local} "])`)

  const VOLATILE_DATA = /^data-(state|highlighted|disabled|orientation|side|align|radix|hover|hovered|focus|focused|pressed|active|selected|open|swipe|motion|placeholder|dsh-inspect)/
  const stableId = (id) => !!id && id.length <= 64 && !/^:|^radix-|«|\d{4,}|^[a-f0-9-]{16,}$/i.test(id)

  /** Display-contents elements (the client's `[data-slot]` wrappers) have no box: use their children's union. */
  function boxOf(el, depth = 0) {
    let r = null
    try { r = el.getBoundingClientRect() } catch (error) { return null }
    if (r && (r.width > 0 || r.height > 0)) return r
    let display = ''
    try { display = getComputedStyle(el).display } catch (error) { /* detached element: no computed style */ }
    if (display !== 'contents' || depth > 8) return r
    let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity
    for (const child of el.children) {
      const c = boxOf(child, depth + 1)
      if (!c || (c.width === 0 && c.height === 0)) continue
      L = Math.min(L, c.left); T = Math.min(T, c.top); R = Math.max(R, c.right); B = Math.max(B, c.bottom)
    }
    if (L === Infinity) return r
    return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }
  }

  /** The part of the element actually on screen: clipped by the viewport and by overflow-clipping ancestors. */
  function visibleBox(el) {
    const r = boxOf(el)
    if (!r) return null
    let L = r.left, T = r.top, R = r.right, B = r.bottom
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      let cs
      try { cs = getComputedStyle(a) } catch (error) { break }
      const clipX = cs.overflowX !== 'visible'
      const clipY = cs.overflowY !== 'visible'
      if (clipX || clipY) {
        const ar = a.getBoundingClientRect()
        if (clipX) { L = Math.max(L, ar.left); R = Math.min(R, ar.right) }
        if (clipY) { T = Math.max(T, ar.top); B = Math.min(B, ar.bottom) }
      }
      if (cs.position === 'fixed') break
    }
    const vw = document.documentElement.clientWidth || innerWidth
    const vh = document.documentElement.clientHeight || innerHeight
    L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, vw); B = Math.min(B, vh)
    if (R <= L || B <= T) return null
    return { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T }
  }

  function shortName(el) {
    if (!isElement(el)) return String(el)
    const { local, plain } = classInfo(el)
    let s = el.localName
    if (stableId(el.id)) s += `#${el.id}`
    const slot = el.getAttribute('data-slot')
    if (slot) s += `[data-slot="${slot}"]`
    for (const c of local.slice(0, 2)) s += `._${c.local}`
    for (const c of plain.slice(0, 2)) s += `.${c}`
    return s
  }

  // ---------- selector ----------

  function qualifiers(el) {
    const q = []
    if (stableId(el.id)) q.push(`#${cssEscape(el.id)}`)
    for (const name of ['data-slot', 'data-testid']) if (el.hasAttribute(name)) q.push(attrSelector(name, el.getAttribute(name)))
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith('data-') || a.name === 'data-slot' || a.name === 'data-testid') continue
      if (VOLATILE_DATA.test(a.name) || a.value.length > 60) continue
      q.push(attrSelector(a.name, a.value))
    }
    const { local, plain } = classInfo(el)
    for (const c of local.slice(0, 2)) q.push(localClassSelector(c))
    for (const c of plain.slice(0, 2)) q.push(`.${cssEscape(c)}`)
    const role = el.getAttribute('role')
    if (role) q.push(attrSelector('role', role))
    const label = el.getAttribute('aria-label')
    if (label && label.length <= 60) q.push(attrSelector('aria-label', label))
    return q
  }

  function nthOfType(el) {
    let i = 1
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === el.localName) i++
    return i
  }

  /**
   * A selector that survives client rebuilds where it can: data attributes, ids,
   * the `local` part of CSS-module classes, roles and labels, then :nth-of-type.
   */
  function buildSelector(el) {
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 14; depth++) {
      const seg = node.localName + qualifiers(node).slice(0, 3).join('')
      parts.unshift(seg)
      let sel = parts.join(' > ')
      if (count(sel) === 1 && document.querySelector(sel) === el) return { selector: sel, unique: true, matches: 1 }
      if (node.parentElement) {
        parts[0] = `${seg}:nth-of-type(${nthOfType(node)})`
        sel = parts.join(' > ')
        if (count(sel) === 1 && document.querySelector(sel) === el) return { selector: sel, unique: true, matches: 1 }
      }
      if (node === document.documentElement) break
      node = node.parentElement
    }
    const sel = parts.join(' > ')
    let first = null
    try { first = document.querySelector(sel) } catch (error) { /* reported via matches: -1 */ }
    return { selector: sel, unique: false, matches: count(sel), matchesElement: first === el }
  }

  /** Every element from the root to `el`, as `tag:nth-of-type` — exact for this DOM, not stable across renders. */
  function domPath(el) {
    const parts = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) parts.unshift(n.parentElement ? `${n.localName}:nth-of-type(${nthOfType(n)})` : n.localName)
    return parts.join(' > ')
  }

  // ---------- accessibility ----------

  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', password: 'textbox', number: 'spinbutton' }
  const TAG_ROLES = { button: 'button', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', ul: 'list', ol: 'list', li: 'listitem', img: 'img', textarea: 'textbox', select: 'combobox', dialog: 'dialog', table: 'table', form: 'form', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', summary: 'button', details: 'group', progress: 'progressbar', hr: 'separator', option: 'option', fieldset: 'group' }
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'tab', 'option', 'treeitem', 'cell', 'columnheader', 'rowheader', 'switch', 'checkbox', 'radio'])

  function implicitRole(el) {
    const tag = el.localName
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    return TAG_ROLES[tag] || null
  }

  function accessibleName(el, role) {
    const ids = el.getAttribute('aria-labelledby')
    if (ids) {
      const text = ids.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText || n.textContent || '').join(' ').trim()
      if (text) return { name: clip(text, 300), from: 'aria-labelledby' }
    }
    const label = el.getAttribute('aria-label')
    if (label && label.trim()) return { name: clip(label.trim(), 300), from: 'aria-label' }
    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels).map((l) => l.innerText || '').join(' ').trim()
      if (text) return { name: clip(text, 300), from: 'label' }
    }
    for (const attr of ['alt', 'title', 'placeholder']) {
      const v = el.getAttribute(attr)
      if (v && v.trim()) return { name: clip(v.trim(), 300), from: attr }
    }
    if (role && NAME_FROM_CONTENT.has(role)) {
      const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
      if (text) return { name: clip(text, 300), from: 'content' }
    }
    return { name: '', from: null }
  }

  function accessibility(el) {
    const explicit = el.getAttribute('role')
    const role = explicit || implicitRole(el)
    const aria = {}
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('aria-')) aria[a.name] = clip(a.value, 200)
    const active = document.activeElement
    return {
      role,
      roleSource: explicit ? 'attribute' : role ? 'implicit' : null,
      ...accessibleName(el, role),
      aria,
      tabIndex: el.tabIndex,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      hidden: el.hidden === true || !!el.closest('[aria-hidden="true"],[hidden],[inert]'),
      focused: active === el,
      containsFocus: !!active && active !== el && el.contains(active),
    }
  }

  // ---------- slots, React ----------

  function slotChain(el) {
    const chain = []
    for (let n = el, depth = 0; n && n.nodeType === 1; n = n.parentElement, depth++) {
      const slot = n.getAttribute('data-slot')
      if (slot) chain.push({ slot, depth })
    }
    return chain
  }

  function fiberKey(el) {
    for (const key of Object.keys(el)) if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return key
    return null
  }

  function componentName(type) {
    if (!type || typeof type === 'string') return null
    if (typeof type === 'function') return type.displayName || type.name || '(anonymous)'
    if (typeof type === 'object') {
      if ('_context' in type || 'Provider' in type || 'Consumer' in type) return null
      if (type.displayName) return type.displayName
      if (type.render) return `ForwardRef(${type.render.displayName || type.render.name || ''})`
      if (type.type) return `Memo(${componentName(type.type) || ''})`
    }
    return null
  }

  function propValue(v, o) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'string') return clip(v, o.propChars)
    if (typeof v === 'undefined') return 'undefined'
    if (typeof v === 'function') return `ƒ ${v.name || ''}`.trim()
    if (typeof v === 'symbol') return String(v)
    if (Array.isArray(v)) return `Array(${v.length})`
    if (typeof v === 'object') {
      if (v.$$typeof) return `<${componentName(v.type) || (typeof v.type === 'string' ? v.type : 'element')}>`
      if (isElement(v)) return `<${shortName(v)}>`
      const keys = Object.keys(v)
      return `{${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`
    }
    return String(v)
  }

  function propsSummary(props, o) {
    if (!props || typeof props !== 'object') return undefined
    const out = {}
    const keys = Object.keys(props)
    for (const key of keys.slice(0, o.propKeys)) {
      try { out[key] = propValue(props[key], o) } catch (error) { out[key] = `[unreadable: ${errorText(error)}]` }
    }
    if (keys.length > o.propKeys) out['…'] = `${keys.length - o.propKeys} more`
    return out
  }

  function react(el, o) {
    let host = el
    let key = null
    for (; host && host.nodeType === 1; host = host.parentElement) { key = fiberKey(host); if (key) break }
    if (!key) return { found: false }
    const components = []
    let fiber = host[key]
    for (let steps = 0; fiber && steps < 5000 && components.length < o.reactDepth; steps++, fiber = fiber.return) {
      let name = null
      try { name = componentName(fiber.type) } catch (error) { name = null }
      if (!name) continue
      const entry = { name }
      if (fiber.key != null) entry.key = String(fiber.key)
      if (components.length < o.reactProps) {
        try { entry.props = propsSummary(fiber.memoizedProps, o) } catch (error) { entry.propsError = errorText(error) }
      }
      components.push(entry)
    }
    return { found: true, hostElement: host === el ? 'self' : shortName(host), components }
  }

  // ---------- sections ----------

  function styles(el, o) {
    const cs = getComputedStyle(el)
    const out = {}
    for (const prop of o.styles) {
      const v = cs.getPropertyValue(prop)
      if (v !== '') out[prop] = clip(v, 300)
    }
    if (o.customProperties) {
      const custom = {}
      let n = 0
      for (let i = 0; i < cs.length && n < o.customPropertyLimit; i++) {
        const name = cs[i]
        if (!name.startsWith('--')) continue
        custom[name] = clip(cs.getPropertyValue(name).trim(), 200)
        n++
      }
      out.customProperties = custom
    }
    return out
  }

  function ancestorList(el, o) {
    const out = []
    for (let n = el.parentElement, depth = 1; n && n.nodeType === 1 && depth <= o.ancestors; n = n.parentElement, depth++) {
      const entry = { depth, name: shortName(n) }
      const r = boxOf(n)
      if (r) entry.rect = rectJSON(r)
      const role = n.getAttribute('role')
      if (role) entry.role = role
      out.push(entry)
    }
    return out
  }

  function childList(el, o) {
    const kids = Array.from(el.children)
    return {
      count: kids.length,
      items: kids.slice(0, o.children).map((c) => ({ name: shortName(c), text: clip((c.innerText || c.textContent || '').trim().replace(/\s+/g, ' '), 80) })),
    }
  }

  function scrollContainer(el) {
    for (let n = el.parentElement; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (!/(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX)) continue
      if (n.scrollHeight <= n.clientHeight && n.scrollWidth <= n.clientWidth) continue
      return { name: shortName(n), selector: buildSelector(n).selector, scrollTop: n.scrollTop, scrollLeft: n.scrollLeft, scrollHeight: n.scrollHeight, scrollWidth: n.scrollWidth, clientHeight: n.clientHeight, clientWidth: n.clientWidth }
    }
    const s = document.scrollingElement
    return s ? { name: 'document', scrollTop: s.scrollTop, scrollLeft: s.scrollLeft, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight } : null
  }

  function formState(el) {
    const tag = el.localName
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      return { type, value: type === 'password' ? '[redacted]' : clip(el.value, 500), checked: el.checked, readOnly: el.readOnly }
    }
    if (tag === 'textarea') return { type: 'textarea', value: clip(el.value, 1000), readOnly: el.readOnly }
    if (tag === 'select') return { type: 'select', value: el.value, selectedIndex: el.selectedIndex }
    if (el.isContentEditable) return { type: 'contenteditable', value: clip(el.innerText || '', 1000) }
    return undefined
  }

  function page() {
    const html = document.documentElement
    const attrs = {}
    for (const a of Array.from(html.attributes)) attrs[a.name] = clip(a.value, 200)
    const vv = globalThis.visualViewport
    const out = {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      userAgent: navigator.userAgent,
      viewport: {
        innerWidth, innerHeight,
        clientWidth: html.clientWidth, clientHeight: html.clientHeight,
        devicePixelRatio: globalThis.devicePixelRatio,
        visual: vv ? { scale: vv.scale, width: round(vv.width), height: round(vv.height), offsetLeft: round(vv.offsetLeft), offsetTop: round(vv.offsetTop) } : null,
      },
      scroll: { x: scrollX, y: scrollY },
      htmlAttributes: attrs,
      colorScheme: globalThis.matchMedia ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : null,
    }
    try { out.app = safeJSON(globalThis.__DEEPSEA_APP__) } catch (error) { out.app = `[unreadable: ${errorText(error)}]` }
    try { out.transport = safeJSON(globalThis.__DSH_TRANSPORT__) } catch (error) { out.transport = `[unreadable: ${errorText(error)}]` }
    try {
      const boot = globalThis.__DSH_BOOT__
      if (boot && typeof boot === 'object') {
        const entries = Array.isArray(boot.entries) ? boot.entries : []
        out.clientPlugins = { rev: typeof boot.rev === 'string' ? boot.rev : null, count: entries.length, ids: entries.slice(0, 300).map((e) => (e && typeof e.id === 'string' ? e.id : '?')) }
      }
    } catch (error) { out.clientPlugins = `[unreadable: ${errorText(error)}]` }
    try {
      const active = document.activeElement
      if (isElement(active) && active !== document.body) out.activeElement = { name: shortName(active), selector: buildSelector(active).selector }
    } catch (error) { out.activeElementError = errorText(error) }
    return out
  }

  // ---------- describe ----------

  function resolveTarget(target) {
    if (isElement(target)) return target
    if (typeof target === 'string') return document.querySelector(target)
    if (target && typeof target === 'object') {
      if (typeof target.selector === 'string') {
        const all = document.querySelectorAll(target.selector)
        const nth = Number.isInteger(target.nth) ? target.nth : 0
        return all[nth < 0 ? all.length + nth : nth] || null
      }
      if (typeof target.x === 'number' && typeof target.y === 'number') return document.elementFromPoint(target.x, target.y)
    }
    return null
  }

  function describe(target, options) {
    const started = Date.now()
    const o = resolveOptions(options)
    const want = new Set(o.sections)
    const errors = {}
    const record = { inspector: { version: VERSION, sections: o.sections, errors } }
    let el = null
    try { el = resolveTarget(target) } catch (error) { errors.target = errorText(error) }
    if (want.has('page')) {
      try { record.page = page() } catch (error) { errors.page = errorText(error) }
    }
    if (!isElement(el)) {
      record.inspector.found = false
      record.inspector.durationMs = Date.now() - started
      return record
    }
    record.inspector.found = true
    const element = {}
    record.element = element
    const run = (name, fn) => {
      if (!want.has(name)) return
      try { const v = fn(); if (v !== undefined) element[name] = v } catch (error) { errors[name] = errorText(error) }
    }
    try {
      const { raw, local, plain } = classInfo(el)
      element.tag = el.localName
      element.name = shortName(el)
      if (el.id) element.id = el.id
      element.classes = raw
      element.localClasses = local.map((c) => c.local)
      element.plainClasses = plain
      const attributes = {}
      for (const a of Array.from(el.attributes)) if (a.name !== 'class' && a.name !== 'style') attributes[a.name] = clip(a.value, 300)
      element.attributes = attributes
      const inline = el.getAttribute('style')
      if (inline) element.inlineStyle = clip(inline, 600)
      element.connected = el.isConnected
    } catch (error) { errors.element = errorText(error) }
    run('selector', () => ({ ...buildSelector(el), domPath: domPath(el) }))
    run('rect', () => {
      const box = boxOf(el)
      const vis = visibleBox(el)
      const m = o.margin
      // `capture` may reach past the viewport; a host leaves that part of its image transparent.
      const capture = vis ? { x: round(vis.left - m), y: round(vis.top - m), width: round(vis.width + 2 * m), height: round(vis.height + 2 * m), margin: m } : null
      return { box: rectJSON(box), visible: rectJSON(vis), capture, fullyVisible: !!(box && vis && Math.abs(box.width - vis.width) < 1 && Math.abs(box.height - vis.height) < 1) }
    })
    run('text', () => {
      const text = (el.innerText || el.textContent || '').trim()
      return { length: text.length, value: clip(text, o.textChars) }
    })
    run('html', () => { const html = el.outerHTML || ''; return { length: html.length, value: clip(html, o.htmlChars) } })
    run('accessibility', () => accessibility(el))
    run('styles', () => styles(el, o))
    run('slots', () => slotChain(el))
    run('react', () => react(el, o))
    run('ancestors', () => ancestorList(el, o))
    run('children', () => childList(el, o))
    run('scroll', () => scrollContainer(el))
    run('form', () => formState(el))
    record.inspector.durationMs = Date.now() - started
    return record
  }

  // ---------- pick ----------

  let active = null

  function pick(options) {
    if (active) active.cancel()
    const o = resolveOptions(options)
    return new Promise((resolvePick) => {
      const color = /^#[0-9a-f]{3,8}$/i.test(o.highlight) ? o.highlight : DEFAULTS.highlight
      const host = document.createElement('div')
      host.setAttribute('data-deepsea-inspect-overlay', '')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block'
      const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host
      root.innerHTML = `<style>
        .box{position:fixed;pointer-events:none;box-sizing:border-box;border:2px solid ${color};background:${color}26;border-radius:2px;display:none}
        .tag{position:fixed;pointer-events:none;font:11px/1.4 ui-monospace,Menlo,monospace;color:#fff;background:${color};padding:2px 6px;border-radius:4px;white-space:nowrap;max-width:70vw;overflow:hidden;text-overflow:ellipsis;display:none;box-shadow:0 1px 4px #0004}
      </style><div class="box"></div><div class="tag"></div>`
      const box = root.querySelector('.box')
      const tag = root.querySelector('.tag')
      const cursor = document.createElement('style')
      cursor.textContent = '*,*::before,*::after{cursor:crosshair!important}'
      ;(document.head || document.documentElement).appendChild(cursor)
      document.documentElement.appendChild(host)

      let leaf = null
      let up = 0
      let done = false
      // Where the pointer was (viewport CSS px): the click point, else the last hover position.
      let pointer = null
      const current = () => {
        let el = leaf
        for (let i = 0; i < up && el && el.parentElement; i++) el = el.parentElement
        return el
      }
      const draw = () => {
        const el = current()
        const r = el ? boxOf(el) : null
        if (!r) { box.style.display = 'none'; tag.style.display = 'none'; return }
        Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
        let slot = ''
        try { const chain = slotChain(el); if (chain.length) slot = `  ⟨${chain[0].slot}⟩` } catch (error) { slot = '' }
        tag.textContent = `${shortName(el)}  ${Math.round(r.width)}×${Math.round(r.height)}${slot}`
        tag.style.display = 'block'
        const above = r.top - 22
        tag.style.top = `${above >= 2 ? above : Math.min(r.bottom + 4, innerHeight - 22)}px`
        tag.style.left = `${Math.max(2, Math.min(r.left, innerWidth - tag.offsetWidth - 2))}px`
      }
      const hit = (x, y) => {
        const t = document.elementFromPoint(x, y)
        return t && t !== host && !host.contains(t) ? t : null
      }
      const onMove = (e) => {
        pointer = { x: e.clientX, y: e.clientY }
        const t = hit(e.clientX, e.clientY)
        if (t && t !== leaf) { leaf = t; up = 0; draw() }
      }
      const block = (e) => { e.preventDefault(); e.stopImmediatePropagation() }
      const onPress = (e) => {
        block(e)
        if (e.type !== 'click') return
        pointer = { x: e.clientX, y: e.clientY }
        if (!leaf) leaf = hit(e.clientX, e.clientY)
        finish(current(), 'click')
      }
      const onKey = (e) => {
        if (e.key === 'Escape') { block(e); finish(null) }
        else if (e.key === 'Enter') { block(e); finish(current(), 'enter') }
        else if (e.key === 'ArrowUp') { block(e); const el = current(); if (el && el.parentElement && el !== document.documentElement) up++; draw() }
        else if (e.key === 'ArrowDown') { block(e); if (up > 0) up--; draw() }
      }
      const pressEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']
      const listen = (on) => {
        const method = on ? 'addEventListener' : 'removeEventListener'
        window[method]('mousemove', onMove, true)
        window[method]('pointermove', onMove, true)
        for (const type of pressEvents) window[method](type, onPress, true)
        window[method]('keydown', onKey, true)
        window[method]('keyup', block, true)
        window[method]('scroll', draw, true)
        window[method]('resize', draw, true)
      }
      const teardown = () => {
        listen(false)
        try { host.remove() } catch (error) { /* already detached by a page re-render */ }
        try { cursor.remove() } catch (error) { /* already detached */ }
      }
      const finish = (el, via) => {
        if (done) return
        done = true
        if (active && active.finish === finish) active = null
        teardown()
        if (!el) { resolvePick(null); return }
        // Two frames so the overlay is gone from the painted page before a host snapshots it.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          let record
          try { record = describe(el, o) } catch (error) { record = { inspector: { version: VERSION, found: false, errors: { describe: errorText(error) } } } }
          record.pick = { via, levelsUp: up, pointer }
          resolvePick(record)
        }))
      }
      active = { finish, cancel: () => finish(null) }
      listen(true)
    })
  }

  // ---------- markdown ----------

  function markdown(record) {
    const lines = []
    const r = record && typeof record === 'object' ? record : {}
    const el = r.element || {}
    const add = (s) => lines.push(s)
    const json = (v) => '```json\n' + JSON.stringify(v, null, 2) + '\n```'
    add(`# Element snapshot: \`${el.name || '(none)'}\``)
    add('')
    if (r.capturedAt) add(`- Captured: ${r.capturedAt}`)
    if (r.native && r.native.app) {
      const a = r.native.app
      add(`- App: ${a.name || '?'} (variant \`${a.variant || '?'}\`, pid ${a.pid}, ${a.bundlePath || '?'})`)
    }
    if (r.page) add(`- Page: ${r.page.url} — "${r.page.title}"`)
    if (r.files) for (const [k, v] of Object.entries(r.files)) add(`- ${k}: \`${v}\``)
    if (r.images) for (const [k, v] of Object.entries(r.images)) if (v && v.path) add(`- ${k} image (symlink target, sha256 ${String(v.sha256).slice(0, 12)}…): \`${v.path}\``)
    add('')
    if (el.selector) {
      add('## Selector')
      add('')
      add('```css\n' + el.selector.selector + '\n```')
      add(`unique: ${el.selector.unique}${el.selector.unique ? '' : `, matches: ${el.selector.matches}`}`)
      add('')
    }
    if (Array.isArray(el.slots)) {
      add('## Slots (nearest first)')
      add('')
      add(el.slots.length ? el.slots.map((s) => `- \`${s.slot}\` (depth ${s.depth})`).join('\n') : '- none')
      add('')
    }
    if (el.react) {
      add('## React components (nearest first)')
      add('')
      if (!el.react.found) add('- no React fiber found')
      else for (const c of el.react.components || []) add(`- ${c.name}${c.key ? ` key=${c.key}` : ''}${c.props ? ` — props: ${Object.keys(c.props).join(', ')}` : ''}`)
      add('')
    }
    if (el.rect) { add('## Geometry (CSS px, viewport-relative)'); add(''); add(json(el.rect)); add('') }
    const shot = r.snapshot && r.snapshot.element
    if (shot && shot.elementInImage) {
      const e = shot.elementInImage
      add(`element.png is the element's visible part plus a ${shot.marginCSS} CSS px margin on every side (transparent where it leaves the window): the element occupies x ${e.x}–${e.x + e.width}, y ${e.y}–${e.y + e.height} points of the image (×${r.snapshot.backingScaleFactor} for pixels).`)
      add('')
    }
    if (el.accessibility) { add('## Accessibility'); add(''); add(json(el.accessibility)); add('') }
    if (el.text) { add(`## Text (${el.text.length} chars)`); add(''); add('```text\n' + el.text.value + '\n```'); add('') }
    if (el.ancestors) { add('## Ancestors'); add(''); for (const a of el.ancestors) add(`- ${a.depth}: \`${a.name}\`${a.rect ? ` ${Math.round(a.rect.width)}×${Math.round(a.rect.height)}` : ''}`); add('') }
    const errs = r.inspector && r.inspector.errors
    if (errs && Object.keys(errs).length) { add('## Inspector errors'); add(''); add(json(errs)); add('') }
    add('Full data (styles, attributes, HTML, props, page, app) is in the JSON file.')
    return lines.join('\n') + '\n'
  }

  globalThis.__DEEPSEA_INSPECT__ = {
    version: VERSION,
    defaults: DEFAULTS,
    describe,
    pick,
    cancel: () => { if (active) active.cancel() },
    get picking() { return !!active },
    markdown,
  }
  return VERSION
})()
