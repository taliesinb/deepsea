/** Remove blank-line-delimited paragraphs containing any literal, case-sensitive marker. */
export function exciseParagraphs(text, markers) {
  // A wrapped line stays in its paragraph; a blank line may contain spaces/tabs.
  const parts = text.split(/(\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*)/)
  const kept = []
  let removed = 0
  for (let index = 0; index < parts.length; index += 2) {
    const paragraph = parts[index]
    if (markers.some(marker => paragraph.includes(marker))) {
      removed++
    } else {
      kept.push({ text: paragraph, separator: index === 0 ? '' : parts[index - 1] })
    }
  }
  if (removed === 0) return { text, removed }
  return { text: kept.map((part, index) => (index === 0 ? '' : part.separator) + part.text).join(''), removed }
}

function isMapping(value) {
  return value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

/** Validate and detach the deployment's exact provider-to-literal mapping. */
export function resolveConfig(input = {}) {
  if (!isMapping(input)
    || Object.keys(input).some(key => key !== 'providers')) throw new Error('prompt-excision: expected only a providers mapping')
  const providers = Object.hasOwn(input, 'providers') ? input.providers : {}
  if (!isMapping(providers)) throw new Error('prompt-excision: providers must be a mapping')
  const entries = Object.entries(providers).map(([provider, markers]) => {
    if (!provider || provider.trim() !== provider || provider.includes('*')) throw new Error('prompt-excision: provider ids must be nonempty exact names, not wildcards')
    if (!Array.isArray(markers) || markers.some(marker => typeof marker !== 'string' || !marker.trim())) {
      throw new Error('prompt-excision: each provider requires a list of nonempty literal strings')
    }
    return [provider, [...new Set(markers)]]
  })
  return { providers: Object.fromEntries(entries) }
}

/** Transform only initial-system sections, using the final assembly's selected provider. */
export function exciseAssembly(assembly, providers, renderPrompt) {
  const markers = providers.get(assembly.variables.provider)
  if (!markers?.length) return assembly
  let changed = false
  const sections = []
  for (const section of assembly.sections) {
    // Use DSH's strict renderer rather than implementing a second template syntax.
    const rendered = renderPrompt({ ...assembly, sections: [section] })
    const result = exciseParagraphs(rendered, markers)
    if (!result.removed) sections.push(section)
    else {
      changed = true
      if (result.text !== '') sections.push({ ...section, text: result.text, interpolate: false })
    }
  }
  return changed ? { ...assembly, sections } : assembly
}
