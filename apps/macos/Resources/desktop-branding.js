// Shared browser-side identity for the Swift/WebKit and Electron wrappers.
// Kept as a function expression so either host can append its JSON argument.
(function ({ name, glyphColor }) {
  const label = String(name ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim()
  const colour = String(glyphColor ?? '').toUpperCase()
  const hex = /^#[0-9A-F]{6}$/.test(colour) && colour !== '#000000' ? colour : ''
  globalThis.__DEEPSEA_APP__ = { ...globalThis.__DEEPSEA_APP__, name: label, glyphColor: hex }
  const style = document.getElementById('deepsea-app-identity') || document.createElement('style')
  style.id = 'deepsea-app-identity'
  // The Mac wrapper's window material needs a lighter sidebar wash than the
  // client's default 60% tint. The darwin selector leaves Linux unchanged.
  style.textContent = `
    span[class*="_localBuildTitle"],span[class*="_fallbackBrandName"]{display:flex!important;font-size:0!important}
    span[class*="_localBuildTitle"]::before{content:"${label}"!important;font-size:12px!important;line-height:13px!important}
    span[class*="_fallbackBrandName"]::before{content:"${label}"!important;font-size:17px!important;line-height:24px!important}
    span[class*="_buildVersion"]{color:inherit!important;background:none!important;opacity:.4!important;padding:0!important;border-radius:0!important}
    html[data-platform="darwin"] [class*="_sidebarCol"]{background:color-mix(in srgb,var(--dsw-specific-sidebar-fill) 18%,transparent)}
    ${hex ? `span[class*="_brandMark"],span[class*="_railMark"]{color:${hex}!important}` : ''}
  `
  ;(document.head || document.documentElement).appendChild(style)
})
