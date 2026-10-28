/**
 * Pick stage: one line per place the transcripts can be.
 *
 *   From ~/.pi/agent/sessions on <your device>   [Upload]  → the standard chooser
 *        (the DeepSea app opens it at the store; a folder = bulk, one
 *        transcript = single), survivors uploaded, then scanned.
 *   From ~/.pi/agent/sessions on <server>        [Choose]  → the server reads its
 *        own store directly (only when the client is a remote device AND the
 *        server actually has that store).
 *   /import-dsh: From ~/.deepsea on <server>     [Choose]  → the server's own
 *        file-or-folder panel (a home, a sessions folder, a backup or an export).
 *   /import-workspace, /import-session: From ~/Downloads on <your device> [Upload]
 *        (one export file), and on a remote device also From ~/Downloads on
 *        <server> [Choose] (the server's own panel).
 *
 * Purely presentational: filtering, uploading and scanning are the flow's.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DIALOG_DEFAULT } from './dialog-keys.ts'
import { useRef } from 'react'
import type { ReactNode } from 'react'
import type { Source, SourcesResult } from './protocol.ts'
import type { UploadProgress } from './upload.ts'
import { borderColor, brandColor, codeChip, dangerColor, hoverBg, megabytesText, mono, small } from './format.ts'

const STORE_HINT: Record<Source, string> = { claude: '~/.claude/projects', pi: '~/.pi/agent/sessions', dsh: '~', workspace: '~/Downloads', session: '~/Downloads' }


/**
 * A page cannot choose where a file chooser opens; the DeepSea app can, and
 * takes a one-shot hint on its `deepseaApp` script message handler before the
 * next `<input type=file>` opens. A no-op in a browser.
 */
function hintAppPicker(directory: string, message: string): void {
  const handlers = (window as unknown as { webkit?: { messageHandlers?: { deepseaApp?: { postMessage(body: unknown): void } } } }).webkit?.messageHandlers
  try {
    handlers?.deepseaApp?.postMessage({ type: 'open-panel', directory, message, showsHiddenFiles: true })
  } catch { /* not the DeepSea app */ }
}

function Banner({ tone, children }: { tone: 'info' | 'danger', children: ReactNode }) {
  const color = tone === 'danger' ? dangerColor : borderColor
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: '6px 10px', fontSize: 13, lineHeight: 1.45, background: 'rgba(127,127,127,0.07)', borderRadius: 4 }}>
      {children}
    </div>
  )
}

/** Upload progress: files done / total, MB sent, current file. */
function UploadLine({ progress, onCancel }: { progress: UploadProgress, onCancel: () => void }) {
  const ratio = progress.filesTotal === 0 ? 0 : Math.min(1, progress.filesDone / progress.filesTotal)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>Uploading {String(progress.filesDone)} / {String(progress.filesTotal)} file{progress.filesTotal === 1 ? '' : 's'}…</span>
        <span style={small}>{megabytesText(progress.bytesSent)} sent</span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.filesTotal} aria-valuenow={progress.filesDone} style={{ height: 6, borderRadius: 3, background: hoverBg, border: `1px solid ${borderColor}`, overflow: 'hidden' }}>
        <div style={{ width: `${String(ratio * 100)}%`, height: '100%', background: brandColor, transition: 'width 200ms ease' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ ...small, ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{progress.currentFile ?? (progress.filesDone === progress.filesTotal ? 'Finishing…' : '')}</span>
        <Button variant="outline" size="sm" style={{ whiteSpace: 'nowrap', flex: 'none' }} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}

function Line({ store, host, fallback, action }: { store: string, host: string | undefined, fallback: string, action: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, minWidth: 0 }}>
      {/* Chips have vertical padding + a border: the line needs a tall enough
          line box and no vertical clipping, or the border loses its top/bottom. */}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: '28px', padding: '2px 0' }}>
        From <code style={codeChip}>{store}</code> on <code style={codeChip}>{host ?? fallback}</code>
      </span>
      {action}
    </div>
  )
}

/**
 * @param props.sources - the host's `sources` (undefined while loading).
 * @param props.upload - in-flight device upload, when any.
 * @param props.deviceError - the filter/upload failure to show.
 * @param props.onFiles - the device chooser's survivors.
 * @param props.onServerStore - "Choose": scan the server's own store.
 */
export function PickStage({ source, label, sources, upload, deviceError, error, onFiles, onServerStore, onCancelUpload }: {
  source: Source
  label: string
  sources: SourcesResult | undefined
  upload: UploadProgress | undefined
  deviceError: string | undefined
  error: string | undefined
  onFiles: (files: FileList) => void
  onServerStore: () => void
  onCancelUpload: () => void
}) {
  const folderInput = useRef<HTMLInputElement | null>(null)
  const store = sources?.sources[source].defaultRoot ?? STORE_HINT[source]
  const busy = upload !== undefined
  const serverHost = sources?.server.host
  const clientHost = sources?.client.host
  const remote = sources !== undefined && !sources.client.sameMachine
  const serverHasStore = sources?.sources[source].exists === true
  /** One export file, not a folder of transcripts. */
  const exportFile = source === 'workspace' || source === 'session'

  const openChooser = (): void => {
    if (source === 'dsh') { onServerStore(); return }
    const input = folderInput.current
    if (input === null) return
    hintAppPicker(store, exportFile ? `Choose a ${source} export` : `Choose ${label} transcripts`)
    input.value = ''
    input.click()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input
        ref={(node) => {
          folderInput.current = node
          // Folder chooser; the DeepSea app's panel also accepts a single file.
          // /import-dsh never opens it: the server's own panel takes a home or a backup ZIP.
          if (source !== 'dsh' && !exportFile) {
            node?.setAttribute('webkitdirectory', '')
            node?.setAttribute('directory', '')
          }
        }}
        type="file"
        multiple={!exportFile}
        {...exportFile ? { accept: '.zip' } : {}}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => { const files = event.target.files; if (files !== null && files.length > 0) onFiles(files) }}
      />
      <Line
        store={store}
        host={source === 'dsh' ? serverHost : clientHost}
        fallback={source === 'dsh' ? 'the server' : remote ? 'your device' : 'this device'}
        action={<Button variant="primary" size="sm" {...DIALOG_DEFAULT} disabled={busy || sources === undefined} onClick={openChooser}>{source === 'dsh' ? 'Choose' : 'Upload'}</Button>}
      />
      {remote && serverHasStore && (
        <Line
          store={store}
          host={serverHost}
          fallback="remote device"
          action={<Button variant="outline" size="sm" disabled={busy} onClick={onServerStore}>Choose</Button>}
        />
      )}
      {upload !== undefined && <UploadLine progress={upload} onCancel={onCancelUpload} />}
      {sources === undefined && error === undefined && <div style={small}>Loading…</div>}
      {deviceError !== undefined && <Banner tone="danger">{deviceError}</Banner>}
      {error !== undefined && <Banner tone="danger">{error}</Banner>}
    </div>
  )
}
