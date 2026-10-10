/**
 * The profiles card on this bundle's page in the Plugins panel, over the host
 * half's Fetch routes (index.js):
 *
 *   - Active: which profile the GUI shows, or None (the shipped look).
 *     Changing it reloads the page, because the brand is rendered into the
 *     boot document, and the new page opens this card again;
 *   - the profiles: Edit, Duplicate, Rename (inline), Export (a .brand.zip
 *     download), Delete (with an inline confirmation);
 *   - New (an empty profile, named in the field beside it) and Import… (a
 *     .brand.zip, named after the file);
 *   - the editor of one profile, with mark and font files uploaded straight
 *     into the profile directory. Saving the active profile reloads.
 *
 * File choosers are the card's own hidden `<input type=file>` elements
 * (`data-deepsea-brand-kit-input="import" | "mark" | "font"`). Every action
 * answers with the host's new state.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'

/** The host's routes (brand.mjs API_PATH), document-relative so a proxied mount works. */
const API = './api/deepsea-brand-kit'

/** A profile.json: the brand with file names (brand.mjs). */
export interface Profile {
  name?: string
  mark?: string
  markMode?: 'mask' | 'image'
  headline?: string
  turnStatus?: string
  hidePreviewBadge?: boolean
  accent?: string
  accentDark?: string
  fonts?: { file: string, family: string, weight?: number, style?: 'normal' | 'italic' }[]
  brandFont?: Typography
  headlineFont?: Typography
}
interface Typography { family?: string, weight?: number, size?: number, lineHeight?: number, letterSpacing?: number, offsetY?: number }

/** The host's state (index.js `state()`), plus what one action reports. */
interface State {
  active: string
  effective: string
  activeError?: string
  profiles: { name: string, profile: Profile | null, error?: string }[]
  error?: string
  created?: string
  uploaded?: string
}

async function answer(response: Response): Promise<State> {
  const state = await response.json() as State
  if (!response.ok) throw new Error(state.error ?? `HTTP ${String(response.status)}`)
  return state
}

/** A state change: POST JSON `{ action, name, … }`. */
function act(action: string, body: Record<string, unknown>): Promise<State> {
  return fetch(API, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  }).then(answer)
}

/** A file to one of the byte routes (`upload`, `import`). */
function send(route: 'upload' | 'import', params: Record<string, string>, file: File): Promise<State> {
  return fetch(`${API}/${route}?${new URLSearchParams(params).toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  }).then(answer)
}

/** Set before a reload so the new page opens this bundle's page again (index.tsx). */
export const REOPEN_KEY = 'deepsea.brand-kit.reopen'

/** Reload the page (the brand is in the boot document) and come back to this card. */
function reloadOnThisPage(): void {
  try { sessionStorage.setItem(REOPEN_KEY, '1') } catch { /* storage unavailable: the reload still applies */ }
  location.reload()
}

/** Download a URL as a file (the export route answers with an attachment). */
function download(url: string, file: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = file
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const MARK_ACCEPT = '.svg,.png'
const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf'

/** A hidden file chooser the card opens with a button. */
function FilePicker({ kind, accept, onFile, picker }: { kind: string, accept: string, onFile: (file: File) => void, picker: RefObject<HTMLInputElement> }) {
  return (
    <input
      ref={picker}
      type="file"
      accept={accept}
      hidden
      data-deepsea-brand-kit-input={kind}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file !== undefined) onFile(file)
      }}
    />
  )
}

type Run = (work: () => Promise<State | undefined>) => Promise<void>

/** The bundle's configuration card. */
export function BrandProfilesCard({ view }: PluginConfigViewProps) {
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const importPicker = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await answer(await fetch(API, { credentials: 'same-origin' })))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const run: Run = useCallback(async (work) => {
    setBusy(true)
    setError(null)
    try {
      const next = await work()
      if (next !== undefined) setState(next)
    } catch (e) {
      await refresh()
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  if (view !== 'page') return null
  if (state === null) return <div className="deepsea-brand-kit-card"><span className="deepsea-brand-kit-muted">{error ?? 'Loading…'}</span></div>

  const activate = (name: string) => run(async () => {
    const next = await act('apply', { name })
    reloadOnThisPage()
    return next
  })
  const create = () => {
    const name = newName.trim()
    if (name === '') return
    void run(async () => {
      const next = await act('create', { name })
      setNewName('')
      setEditing(name)
      return next
    })
  }

  return (
    <div className="deepsea-brand-kit-card">
      <div className="deepsea-brand-kit-row">
        <label htmlFor="deepsea-brand-kit-active">Active</label>
        <select id="deepsea-brand-kit-active" value={state.active} disabled={busy} onChange={(event) => { void activate(event.target.value) }}>
          <option value="">None</option>
          {state.profiles.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}
        </select>
      </div>
      {state.activeError !== undefined && <div className="deepsea-brand-kit-error">Not applied: {state.activeError}</div>}
      {error !== null && <div className="deepsea-brand-kit-error">{error}</div>}

      <ul className="deepsea-brand-kit-list">
        {state.profiles.length === 0 && <li className="deepsea-brand-kit-muted">No profiles</li>}
        {state.profiles.map(row => (
          <ProfileRow
            key={row.name}
            name={row.name}
            error={row.error}
            active={row.name === state.active}
            editing={editing === row.name}
            busy={busy}
            run={run}
            onEdit={() => { setEditing(editing === row.name ? null : row.name) }}
            onRenamed={(to) => { if (editing === row.name) setEditing(to) }}
            onDeleted={() => { if (editing === row.name) setEditing(null) }}
          />
        ))}
      </ul>

      <div className="deepsea-brand-kit-row">
        <input
          type="text"
          className="deepsea-brand-kit-name-field"
          value={newName}
          placeholder="Profile name"
          aria-label="New profile name"
          disabled={busy}
          onChange={(event) => { setNewName(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') create() }}
        />
        <Button variant="primary" size="sm" disabled={busy || newName.trim() === ''} onClick={create}>New</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { importPicker.current?.click() }}>Import…</Button>
        <FilePicker
          kind="import"
          accept=".zip"
          picker={importPicker}
          onFile={(file) => { void run(async () => {
            const next = await send('import', { file: file.name }, file)
            if (next.created !== undefined) setEditing(next.created)
            return next
          }) }}
        />
      </div>

      {editing !== null && state.profiles.some(row => row.name === editing) && (
        <ProfileEditor
          key={editing}
          name={editing}
          initial={state.profiles.find(row => row.name === editing)?.profile ?? {}}
          busy={busy}
          isActive={editing === state.active}
          run={run}
        />
      )}
    </div>
  )
}

interface RowProps {
  name: string
  error: string | undefined
  active: boolean
  editing: boolean
  busy: boolean
  run: Run
  onEdit: () => void
  onRenamed: (to: string) => void
  onDeleted: () => void
}

/** One profile in the list, with its actions. */
function ProfileRow({ name, error, active, editing, busy, run, onEdit, onRenamed, onDeleted }: RowProps) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'delete'>('idle')
  const [to, setTo] = useState(name)
  const rename = () => {
    const target = to.trim()
    if (target === '' || target === name) { setMode('idle'); return }
    void run(async () => {
      const next = await act('rename', { name, to: target })
      onRenamed(target)
      return next
    })
  }
  return (
    <li className={`deepsea-brand-kit-item${active ? ' deepsea-brand-kit-active' : ''}`}>
      {mode === 'rename'
        ? (
          <input
            type="text"
            className="deepsea-brand-kit-name-field"
            value={to}
            aria-label="Profile name"
            autoFocus
            onChange={(event) => { setTo(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') rename()
              if (event.key === 'Escape') setMode('idle')
            }}
          />
          )
        : <span className="deepsea-brand-kit-item-name">{name}</span>}
      {active && <span className="deepsea-brand-kit-tag">active</span>}
      {error !== undefined && <span className="deepsea-brand-kit-error" title={error}>invalid</span>}
      {mode === 'rename' && (
        <>
          <Button variant="primary" size="sm" disabled={busy} onClick={rename}>Save</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setMode('idle') }}>Cancel</Button>
        </>
      )}
      {mode === 'delete' && (
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setMode('idle') }}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run(async () => { const next = await act('delete', { name }); onDeleted(); return next }) }}>Delete {name}</Button>
        </>
      )}
      {mode === 'idle' && (
        <>
          <Button variant="outline" size="sm" disabled={busy} onClick={onEdit}>{editing ? 'Close' : 'Edit'}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(() => act('duplicate', { name })) }}>Duplicate</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setTo(name); setMode('rename') }}>Rename</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { download(`${API}/export?name=${encodeURIComponent(name)}`, `${name}.brand.zip`) }}>Export</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setMode('delete') }}>Delete</Button>
        </>
      )}
    </li>
  )
}

interface EditorProps {
  name: string
  initial: Profile
  busy: boolean
  isActive: boolean
  run: Run
}

/** One profile's fields; Save validates on the host. */
function ProfileEditor({ name, initial, busy, isActive, run }: EditorProps) {
  const [draft, setDraft] = useState<Profile>(() => structuredClone(initial))
  const markPicker = useRef<HTMLInputElement>(null)
  const fontPicker = useRef<HTMLInputElement>(null)
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) => { setDraft(d => ({ ...d, [key]: value })) }
  const setType = (key: 'brandFont' | 'headlineFont', field: keyof Typography, value: string) => {
    setDraft((d) => {
      const block: Typography = { ...(d[key] ?? {}) }
      if (field === 'family') {
        if (value === '') delete block.family
        else block.family = value
      } else if (value === '') {
        delete block[field]
      } else {
        block[field] = Number(value)
      }
      return { ...d, [key]: block }
    })
  }
  const save = () => run(async () => {
    const next = await act('save', { name, profile: draft })
    if (isActive) reloadOnThisPage()
    return next
  })
  const fonts = draft.fonts ?? []
  const id = (field: string) => `deepsea-brand-kit-${field}`

  return (
    <div className="deepsea-brand-kit-form">
      <div className="deepsea-brand-kit-heading">{name}</div>
      <label htmlFor={id('wordmark')}>Wordmark</label>
      <input id={id('wordmark')} type="text" value={draft.name ?? ''} placeholder="Name" onChange={(e) => { set('name', e.target.value) }} />

      <label>Mark</label>
      <div className="deepsea-brand-kit-inline">
        <span className={draft.mark ? '' : 'deepsea-brand-kit-muted'}>{draft.mark || 'None'}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { markPicker.current?.click() }}>Upload…</Button>
        {draft.mark && <Button variant="outline" size="sm" disabled={busy} onClick={() => { set('mark', '') }}>Clear</Button>}
        <select value={draft.markMode ?? 'mask'} aria-label="Mark mode" onChange={(e) => { set('markMode', e.target.value as 'mask' | 'image') }}>
          <option value="mask">Mask</option>
          <option value="image">Image</option>
        </select>
        <FilePicker
          kind="mark"
          accept={MARK_ACCEPT}
          picker={markPicker}
          onFile={(file) => { void run(async () => {
            const next = await send('upload', { name, kind: 'mark', file: file.name }, file)
            set('mark', next.uploaded ?? file.name)
            return next
          }) }}
        />
      </div>

      <label htmlFor={id('headline')}>Headline</label>
      <input id={id('headline')} type="text" value={draft.headline ?? ''} placeholder="Into the Unknown" onChange={(e) => { set('headline', e.target.value) }} />
      <label htmlFor={id('turn-status')}>Turn status</label>
      <input id={id('turn-status')} type="text" value={draft.turnStatus ?? ''} placeholder="Deep diving" onChange={(e) => { set('turnStatus', e.target.value) }} />
      <label htmlFor={id('preview-badge')}>Hide Preview badge</label>
      <div className="deepsea-brand-kit-inline">
        <input id={id('preview-badge')} type="checkbox" checked={draft.hidePreviewBadge ?? false} onChange={(e) => { set('hidePreviewBadge', e.target.checked) }} />
      </div>

      <label htmlFor={id('accent')}>Accent</label>
      <div className="deepsea-brand-kit-inline">
        <input type="color" aria-label="Accent colour" value={draft.accent || '#4176e6'} onChange={(e) => { set('accent', e.target.value) }} />
        <input id={id('accent')} type="text" value={draft.accent ?? ''} placeholder="#rrggbb" onChange={(e) => { set('accent', e.target.value) }} />
        {draft.accent && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setDraft(d => ({ ...d, accent: '', accentDark: '' })) }}>Clear</Button>}
      </div>
      <label htmlFor={id('accent-dark')}>Accent dark</label>
      <div className="deepsea-brand-kit-inline">
        <input type="color" aria-label="Accent dark colour" value={draft.accentDark || draft.accent || '#4176e6'} onChange={(e) => { set('accentDark', e.target.value) }} />
        <input id={id('accent-dark')} type="text" value={draft.accentDark ?? ''} placeholder="#rrggbb" onChange={(e) => { set('accentDark', e.target.value) }} />
      </div>

      <div className="deepsea-brand-kit-heading">Fonts</div>
      <label>Files</label>
      <div className="deepsea-brand-kit-stack">
        {fonts.map((font, index) => (
          <div key={`${font.file}-${String(index)}`} className="deepsea-brand-kit-inline">
            <span className="deepsea-brand-kit-muted">{font.file}</span>
            <input type="text" className="deepsea-brand-kit-family" value={font.family} placeholder="Family" aria-label="Family" onChange={(e) => { set('fonts', fonts.map((f, i) => (i === index ? { ...f, family: e.target.value } : f))) }} />
            <input type="number" value={font.weight ?? 400} min={100} max={900} step={100} aria-label="Weight" onChange={(e) => { set('fonts', fonts.map((f, i) => (i === index ? { ...f, weight: Number(e.target.value) } : f))) }} />
            <select value={font.style ?? 'normal'} aria-label="Style" onChange={(e) => { set('fonts', fonts.map((f, i) => (i === index ? { ...f, style: e.target.value as 'normal' | 'italic' } : f))) }}>
              <option value="normal">Normal</option>
              <option value="italic">Italic</option>
            </select>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { set('fonts', fonts.filter((_, i) => i !== index)) }}>Remove</Button>
          </div>
        ))}
        <div className="deepsea-brand-kit-inline">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { fontPicker.current?.click() }}>Add font file…</Button>
          <FilePicker
            kind="font"
            accept={FONT_ACCEPT}
            picker={fontPicker}
            onFile={(file) => { void run(async () => {
              const next = await send('upload', { name, kind: 'font', file: file.name }, file)
              const family = file.name.replace(/\.[^.]+$/, '').replace(/[-_]?(thin|light|regular|medium|semibold|bold|black|italic)$/i, '').replace(/[-_]+/g, ' ').trim()
              setDraft(d => ({ ...d, fonts: [...(d.fonts ?? []), { file: next.uploaded ?? file.name, family, weight: 400, style: 'normal' }] }))
              return next
            }) }}
          />
        </div>
      </div>
      <TypographyRow label="Wordmark type" value={draft.brandFont ?? {}} shipped={{ weight: 600, size: 18, lineHeight: 24 }} onChange={(field, v) => { setType('brandFont', field, v) }} />
      <TypographyRow label="Headline type" value={draft.headlineFont ?? {}} shipped={{ weight: 500, size: 26, lineHeight: 32 }} onChange={(field, v) => { setType('headlineFont', field, v) }} />

      <div />
      <div className="deepsea-brand-kit-inline">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void save() }}>{isActive ? 'Save and reload' : 'Save'}</Button>
      </div>
    </div>
  )
}

function TypographyRow({ label, value, shipped, onChange }: { label: string, value: Typography, shipped: { weight: number, size: number, lineHeight: number }, onChange: (field: keyof Typography, value: string) => void }) {
  const num = (field: keyof Typography, aria: string, placeholder: string): ReactNode => (
    <input type="number" value={value[field] ?? ''} placeholder={placeholder} aria-label={aria} step="any" onChange={(e) => { onChange(field, e.target.value) }} />
  )
  return (
    <>
      <label>{label}</label>
      <div className="deepsea-brand-kit-inline">
        <input type="text" className="deepsea-brand-kit-family" value={value.family ?? ''} placeholder="Family" aria-label={`${label} family`} onChange={(e) => { onChange('family', e.target.value) }} />
        {num('weight', 'Weight', String(shipped.weight))}
        {num('size', 'Size', String(shipped.size))}
        {num('lineHeight', 'Line height', String(shipped.lineHeight))}
        {num('letterSpacing', 'Letter spacing', '0')}
        {num('offsetY', 'Vertical offset', '0')}
      </div>
    </>
  )
}
