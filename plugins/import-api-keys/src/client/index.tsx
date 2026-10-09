/**
 * Browser half of @deepsea/import-api-keys.
 *
 * `/import-api-keys` is a browser command (ui-commands contribution, kind
 * `action`): picking it in the slash menu or pressing Enter on the bare line
 * runs here and never produces a chat message. Flow:
 *
 *   file picker → parse (parse.mjs: pi auth.json / .credentials.yaml / flat map / .env)
 *   → POST /deepsea-import-api-keys/plan (the host compares with the credential store)
 *   → confirm dialog: one tickable row per key, Import or Cancel
 *   → remote.credentials.set per key (DSH's own write path; consumers
 *     re-resolve per request, so keys are live at once), empty provider
 *     profiles for providers still off → done dialog.
 *
 * Why the plan round trip: `describe` never returns values, so only the host
 * can say whether a stored key DIFFERS. Values cross the wire once for the
 * plan and once per write, over the admitted connection: never the
 * attachment store, never disk in the browser.
 *
 * The same page runs in the DeepSea app, in a framed remote session and in
 * an app connected to another machine's server, which is the point of doing
 * this in the browser: the file lives on the machine the person is at.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// `ctx.remote.credentials` typing rides the assembly package, as in ui-settings-models.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import { DIALOG_DEFAULT, useDialogDefaultAction } from './dialog-keys.ts'
// @ts-expect-error plain ESM without a declaration file; esbuild inlines it
import { PI_PROVIDER_ENV, parseKeyFile } from '../../parse.mjs'

const CHANNEL = '/deepsea-import-api-keys'
const COMMAND = 'import-api-keys'

type PlanStatus = 'new' | 'same' | 'different' | 'readonly' | 'invalid'
interface PlanEntry { status: PlanStatus, source?: string }
interface Skipped { name: string, reason: string }
/** A catalog provider this key would switch on: no profile in settings yet, so the model picker does not list it. */
interface Enable { provider: string, displayName: string, settingsNs: string, settingsPath: string[] }

type Dialog =
  | { kind: 'error', title: string, message: string }
  | { kind: 'confirm', fileName: string, format: string, keys: Record<string, string>, plan: Record<string, PlanEntry>, skipped: Skipped[], enables: Record<string, Enable> }
  | { kind: 'busy', total: number, done: number }
  | { kind: 'done', written: string[], failed: { name: string, message: string }[], unchanged: number, enabled: string[], enableFailed: { name: string, message: string }[] }

type Listener = (dialog: Dialog | undefined) => void

/** One dialog at a time, owned by the plugin; the overlay component subscribes. */
class DialogStore {
  private current: Dialog | undefined
  private readonly listeners = new Set<Listener>()
  get(): Dialog | undefined { return this.current }
  set(dialog: Dialog | undefined): void { this.current = dialog; for (const l of this.listeners) l(dialog) }
  subscribe(l: Listener): () => void { this.listeners.add(l); return () => { this.listeners.delete(l) } }
}

/** pi's auth store; also where the DeepSea app's picker starts when it can. */
const PI_AUTH_DIR = '~/.pi/agent'

/**
 * A page cannot choose where the file picker opens. The DeepSea app can: it
 * takes a one-shot hint on its `deepseaApp` script message handler and
 * applies it to the next open panel (pi's auth.json pre-selected when it
 * exists, else its directory, hidden files shown). In a browser this is a
 * no-op.
 */
function hintAppPicker(): void {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { deepseaApp?: { postMessage(body: unknown): void } } } }).webkit?.messageHandlers
  try {
    handlers?.deepseaApp?.postMessage({ type: 'open-panel', file: `${PI_AUTH_DIR}/auth.json`, directory: PI_AUTH_DIR, message: 'Choose an API-key file', showsHiddenFiles: true })
  } catch { /* not the DeepSea app */ }
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || !(key in (cur as Record<string, unknown>))) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function pickFile(): Promise<File | undefined> {
  hintAppPicker()
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.env,.yaml,.yml,application/json,text/plain,application/yaml'
    input.style.display = 'none'
    let settled = false
    const finish = (file: File | undefined): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(file)
    }
    input.addEventListener('change', () => finish(input.files?.[0]))
    // Cancel: the picker fires `cancel` in current engines; a focus return without a change is the fallback.
    input.addEventListener('cancel', () => finish(undefined))
    window.addEventListener('focus', () => { setTimeout(() => finish(input.files?.[0]), 400) }, { once: true })
    document.body.append(input)
    input.click()
  })
}

const mono = { fontFamily: 'var(--dsh-font-mono, ui-monospace, monospace)', fontSize: 12 } as const

interface Row {
  name: string
  /** ticked by default and tickable / tickable but off / no box at all / box present but disabled */
  box: 'on' | 'off' | 'none' | 'disabled'
  summary: string
  /** the key to store when ticked; absent for a row whose only action is enabling its provider */
  value?: string
  /** provider profile to create when ticked */
  enable?: Enable
}

function enableNote(e: Enable | undefined): string { return e === undefined ? '' : ` · enables ${e.displayName}` }

function rowsFor(d: Extract<Dialog, { kind: 'confirm' }>): Row[] {
  const rows: Row[] = []
  for (const [name, value] of Object.entries(d.keys)) {
    const p = d.plan[name]
    switch (p?.status) {
      case 'new': rows.push({ name, box: 'on', summary: `new — will be added${enableNote(d.enables[name])}`, value, enable: d.enables[name] }); break
      case 'different': rows.push({ name, box: 'off', summary: `already set with a different value — tick to overwrite${enableNote(d.enables[name])}`, value, enable: d.enables[name] }); break
      case 'same': {
        const enable = d.enables[name]
        // Same key, provider still off: the only thing left to do is enable it — a safe default, so pre-ticked.
        if (enable !== undefined) rows.push({ name, box: 'on', summary: `already set with the same value · tick to enable ${enable.displayName}`, enable })
        else rows.push({ name, box: 'none', summary: 'already set with the same value' })
        break
      }
      case 'readonly': rows.push({ name, box: 'disabled', summary: `set by the server's environment (${p.source ?? 'env'}) — cannot be overwritten` }); break
      default: rows.push({ name, box: 'disabled', summary: 'invalid name or empty value' })
    }
  }
  for (const s of d.skipped) rows.push({ name: s.name, box: 'disabled', summary: s.reason })
  return rows
}

/** What Import applies: keys to store, and providers to switch on (for stored keys and for same-value rows). */
interface ImportPlan { keys: Record<string, string>, enables: Enable[] }

function ConfirmTable({ dialog, onImport, onClose }: { dialog: Extract<Dialog, { kind: 'confirm' }>, onImport: (plan: ImportPlan) => Promise<void>, onClose: () => void }) {
  const rows = rowsFor(dialog)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(rows.filter(r => r.box === 'on').map(r => r.name)))
  const selected = rows.filter(r => ticked.has(r.name) && (r.value !== undefined || r.enable !== undefined))
  const toggle = (name: string, on: boolean): void => {
    setTicked(prev => { const next = new Set(prev); if (on) next.add(name); else next.delete(name); return next })
  }
  const cell = { padding: '6px 10px', borderBottom: '1px solid var(--dsh-color-border, rgba(255,255,255,0.08))', verticalAlign: 'top', fontSize: 13, lineHeight: 1.4 } as const
  return (
    <Modal
      open
      title="Import API keys"
      closeLabel="Cancel"
      onClose={onClose}
      width={Math.min(window.innerWidth - 80, 720 + Math.max(0, ...rows.map(r => r.summary.length + r.name.length - 70)) * 6)}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" {...DIALOG_DEFAULT} disabled={selected.length === 0} onClick={() => { void onImport({ keys: Object.fromEntries(selected.filter(r => r.value !== undefined).map(r => [r.name, r.value as string])), enables: selected.map(r => r.enable).filter((e): e is Enable => e !== undefined) }) }}>
          {selected.length === 0 ? 'Import' : `Import ${selected.length}`}
        </Button>
      </>}
    >
      <div style={{ maxHeight: '55vh', overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {rows.map(row => (
              <tr key={row.name} style={{ opacity: row.box === 'disabled' || row.box === 'none' ? 0.65 : 1 }}>
                <td style={{ ...cell, width: 28, paddingRight: 0 }}>
                  {row.box !== 'none' && (
                    <input type="checkbox" aria-label={`import ${row.name}`} checked={ticked.has(row.name)} disabled={row.box === 'disabled'} onChange={e => toggle(row.name, e.target.checked)} />
                  )}
                </td>
                <td style={{ ...cell, ...mono, whiteSpace: 'nowrap' }}>{row.name}</td>
                <td style={{ ...cell, opacity: 0.8, whiteSpace: 'nowrap' }}>{row.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

function ImportDialog({ store, onImport }: { store: DialogStore, onImport: (plan: ImportPlan) => Promise<void> }) {
  const [dialog, setDialog] = useState<Dialog | undefined>(store.get())
  useEffect(() => store.subscribe(setDialog), [store])
  // Enter = the primary button of whichever card is up (Import / OK); Escape = close (Modal's own).
  useDialogDefaultAction(dialog !== undefined, dialog?.kind)
  if (dialog === undefined) return null
  const close = (): void => store.set(undefined)

  if (dialog.kind === 'error') {
    return (
      <Modal open title={dialog.title} closeLabel="Close" onClose={close} width={460} footer={<Button variant="primary" {...DIALOG_DEFAULT} onClick={close}>OK</Button>}>
        <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{dialog.message}</div>
      </Modal>
    )
  }
  if (dialog.kind === 'busy') {
    return <Modal open headless title="Importing API keys" onClose={() => {}} width={380}><div style={{ padding: 20, fontSize: 13 }}>Importing… {dialog.done} / {dialog.total}</div></Modal>
  }
  if (dialog.kind === 'done') {
    return (
      <Modal open title="API keys imported" closeLabel="Close" onClose={close} width={480} footer={<Button variant="primary" {...DIALOG_DEFAULT} onClick={close}>OK</Button>}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          {dialog.written.length > 0 && <div style={{ marginBottom: 8 }}>Stored: <span style={mono}>{dialog.written.join(', ')}</span></div>}
          {dialog.failed.map(f => <div key={f.name} style={{ marginBottom: 4 }}>Failed <span style={mono}>{f.name}</span>: {f.message}</div>)}
          {dialog.enabled.length > 0 && <div style={{ marginBottom: 8 }}>Enabled providers: {dialog.enabled.join(', ')}</div>}
          {dialog.enableFailed.map(f => <div key={f.name} style={{ marginBottom: 4 }}>Could not enable {f.name}: {f.message}</div>)}
          {dialog.written.length === 0 && dialog.failed.length === 0 && dialog.enabled.length === 0 && dialog.enableFailed.length === 0 && <div>Nothing changed.</div>}
        </div>
      </Modal>
    )
  }
  return <ConfirmTable key={dialog.fileName + Object.keys(dialog.keys).join(',')} dialog={dialog} onImport={onImport} onClose={close} />
}

export const name = 'deepsea-import-api-keys'
export const inject = ['slots', 'commandUi', 'connection', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings']

export function apply(ctx: Context): void {
  const store = new DialogStore()
  const rpc = (ctx as unknown as { connection: { rpc: ClientConnectionRpc } }).connection.rpc

  const plan = async (keys: Record<string, string>): Promise<Record<string, PlanEntry>> => {
    const result = await rpc.call(CHANNEL, 'plan', { args: { keys } })
    if (!result.ok) throw new Error(result.error.message)
    return (result.value as { plan: Record<string, PlanEntry> }).plan
  }

  const run = async (): Promise<void> => {
    const file = await pickFile()
    if (file === undefined) return
    let parsed: { format: string, keys: Record<string, string>, skipped: Skipped[] }
    try {
      parsed = parseKeyFile(await file.text())
    } catch (error) {
      store.set({ kind: 'error', title: `Cannot import ${file.name}`, message: error instanceof Error ? error.message : String(error) })
      return
    }
    if (Object.keys(parsed.keys).length === 0) {
      store.set({ kind: 'error', title: `No API keys in ${file.name}`, message: parsed.skipped.map((s: Skipped) => `${s.name}: ${s.reason}`).join('\n') || 'The file contains no usable keys.' })
      return
    }
    try {
      const [planned, enables] = await Promise.all([plan(parsed.keys), findEnables(Object.keys(parsed.keys))])
      store.set({ kind: 'confirm', fileName: file.name, format: parsed.format, keys: parsed.keys, plan: planned, skipped: parsed.skipped, enables })
    } catch (error) {
      store.set({ kind: 'error', title: 'Could not check the existing keys', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Catalog providers a key switches on. A stored key alone does not put a
   * provider in the model picker: the picker lists providers with a profile
   * in settings (Settings ▸ Models "add"). For each imported ref, find the
   * shipped route whose key name it is — the name the host actually resolves
   * is pi-ai's env table, `DERIVED_API_KEY` as the fallback — and which has no
   * profile yet; those get an empty profile written after the keys land, the
   * same `set [...settingsPath] {}` the Models pane writes.
   */
  const findEnables = async (refs: string[]): Promise<Record<string, Enable>> => {
    const out: Record<string, Enable> = {}
    if (refs.length === 0) return out
    const [directory, described] = await Promise.all([ctx.remote.llm.listConfigurableProviders(), ctx.remote.settings.describe()])
    if (!directory.ok || !described.ok) return out
    const namespaces = new Map(described.value.namespaces.map(n => [n.ns, n]))
    for (const entry of directory.value) {
      if (entry.declared === true || entry.settingsPath.length === 0) continue
      const ref = (PI_PROVIDER_ENV as Record<string, string>)[entry.provider] ?? `${entry.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
      if (!refs.includes(ref) || out[ref] !== undefined) continue
      const ns = namespaces.get(entry.settingsNs)
      const configured = ns !== undefined && getPath(ns.value, entry.settingsPath) !== undefined
      if (configured) continue
      out[ref] = { provider: entry.provider, displayName: entry.displayName, settingsNs: entry.settingsNs, settingsPath: [...entry.settingsPath] }
    }
    return out
  }

  const enableProviders = async (enables: Enable[]): Promise<{ enabled: string[], enableFailed: { name: string, message: string }[] }> => {
    const enabled: string[] = []
    const enableFailed: { name: string, message: string }[] = []
    for (const e of enables) {
      const response = await ctx.remote.settings.mutate(e.settingsNs, [{ op: 'set', path: e.settingsPath, value: {} }], undefined)
      if (response.ok) enabled.push(e.displayName)
      else enableFailed.push({ name: e.displayName, message: response.error.message })
    }
    return { enabled, enableFailed }
  }

  const onImport = async ({ keys, enables }: ImportPlan): Promise<void> => {
    const names = Object.keys(keys)
    const confirm = store.get()
    const unchanged = confirm?.kind === 'confirm' ? Object.values(confirm.plan).filter(p => p.status === 'same').length : 0
    store.set({ kind: 'busy', total: names.length, done: 0 })
    const written: string[] = []
    const failed: { name: string, message: string }[] = []
    for (const [i, ref] of names.entries()) {
      const response = await ctx.remote.credentials.set(ref, keys[ref])
      if (response.ok) written.push(ref)
      else failed.push({ name: ref, message: response.error.message })
      store.set({ kind: 'busy', total: names.length, done: i + 1 })
    }
    // Enable for every ticked row whose provider is off, unless that row's key write failed.
    const refOf = new Map<Enable, string>()
    if (confirm?.kind === 'confirm') for (const [ref, e] of Object.entries(confirm.enables)) refOf.set(e, ref)
    const failedNames = new Set(failed.map(f => f.name))
    const { enabled, enableFailed } = await enableProviders(enables.filter(e => !failedNames.has(refOf.get(e) ?? '')))
    store.set({ kind: 'done', written, failed, unchanged, enabled, enableFailed })
  }

  ctx.effect(() => ctx.commandUi.register({
    name: COMMAND,
    label: () => 'import-api-keys',
    description: () => 'Import provider API keys from a file on this machine',
    available: () => true,
    ui: { kind: 'action', run: () => { void run() } },
  }), 'import-api-keys: /import-api-keys')

  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'deepsea-import-api-keys',
    inject: () => ({ store, onImport }),
  }, ({ store, onImport }: { store: DialogStore, onImport: (plan: ImportPlan) => Promise<void> }) => <ImportDialog store={store} onImport={onImport} />)), 'import-api-keys: dialog overlay')
}
