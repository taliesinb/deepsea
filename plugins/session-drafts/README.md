# @deepsea/session-drafts

Prompt drafts kept with their session. Writing a prompt, then needing to
steer the agent with a different one, or noting a prompt for later: save the
composer as a draft, send something else, and resume the draft when it is
time.

## What you see

- **Drafts**, a View beside Chat and Trajectory (in the header's More menu
  when the header is narrow). While it is shown, the composer is hidden;
  Chat brings it back, unchanged. Each draft is a card like a compact
  composer: its attachments and its text with reference chips and quotes,
  editable in place (Enter is a line break; there are no `/` or `@` menus and
  no model or permission controls); its text area is two to sixteen lines
  tall, then scrolls. The card being edited is tinted slightly toward the
  text colour, and a draft just saved flashes the same tint. Under the card,
  a row like a chat message's actions, shown while the pointer is over the
  draft or it is being edited: Send (up arrow), Resume (outline pin), Copy,
  Attach files, Download, then at the right "edited 3h ago", "created 5h
  ago" (the full time on hover) and Delete. Oldest first, so the newest
  draft is at the bottom, just above **New draft**, a button like the
  sidebar's New Session that adds an empty draft and puts the keyboard in
  it; opened from its tab, the View starts at the bottom. A session with no
  drafts shows "No drafts" and the button. Files pasted or dropped onto a
  draft become its attachments.
- **Save as draft**: ⌘D (Ctrl+D off Apple devices) while the composer has
  the keyboard, or the filled-pin button just right of the composer's + button (the same
  light-grey circle; a stylesheet rule moves it there from the end of the
  left controls). The
  composer's text, reference chips, command chip, quotes and attachments go
  to the host as a new draft; once the host has stored it, the composer is
  cleared and the Drafts View opens with that draft highlighted. If the
  composer changed while the attachments uploaded, it is kept as it is. An
  empty composer just opens Drafts. The shortcut is rebindable in Settings →
  Shortcuts ("Save the prompt as a draft").
- **Copy** puts the draft's text on the clipboard (chips as their clipboard
  form, which paste back as chips). **Attach files** opens the file picker
  and adds the files to the draft.
- **Send** (up arrow): Resume, then, once the attachments have uploaded,
  send the composer as the next message (queued while a turn runs, like
  Enter). Once the host has accepted the message the draft is deleted; a
  refused or failed send leaves both the draft and the composer as they
  were.
- **Download** saves the draft as `<created>.<session title>.draft.md` (its
  text, chips in their clipboard form), or, when it has attachments, as
  `….draft.zip` holding `draft.md` (the text, then a Markdown link to each
  attachment) and the attachments. `<created>` is `YYYY-MM-DD-HHMM`, local
  time. The host builds the file and names it in `Content-Disposition`, so
  the browser, and the macOS app, save it to Downloads.
- **Resume** (outline pin, "Resume in Chat"): the composer takes the draft's
  text, chips and attachments, and Chat opens; the draft stays. A composer
  that is not empty is saved as a draft of its own first, so nothing is lost.
- **Delete** (trash): asks once more in the same row, then removes the
  draft.
- Edits are saved 0.8 s after typing stops, when the editor loses focus, and
  before Resume, Send and Download. The View re-reads the session's drafts every 10 s, so a
  draft saved from another window appears; a card with unsaved edits keeps
  them.

## How it works

The browser half reads the composer through the harness's Conversation
service (`SessionInput.readDraft()`, `setDraft(document)`, and the draft
attachment registry: `resolveDraftAttachments`, `createDrafts`,
`releaseDraftAttachment`), renders each card's text with the
`conversation.draft.editor` Factory, and opens Views with
`uiConversation.openView`; those seams are the harness topic
`composer-drafts` (package.json `deepsea.requires`).

Drafts are stored by the host, one directory per session under
`$DSH_HOME/plugins/session-drafts/sessions/<session id>/`: `drafts.json`
(each draft's document, attachments, `createdAt`, `updatedAt`, `revision`
and `position`, the turn at creation) and `blobs/<sha256>` (attachment bytes,
shared between the session's drafts and removed an hour after no draft lists
them). Drafts never enter the session's log, so the model never sees them,
and a session without drafts has no directory. Routes, behind DSH's own
authentication:

| Route | |
|---|---|
| `GET /api/deepsea-session-drafts/list?session=` | the session's drafts, newest first |
| `POST /api/deepsea-session-drafts/create` | `{ sessionId, document, attachments }` → `{ draft }` |
| `POST /api/deepsea-session-drafts/update` | `{ sessionId, id, document, attachments }` → `{ draft }` (the last writer wins) |
| `POST /api/deepsea-session-drafts/delete` | `{ sessionId, id }` |
| `POST /api/deepsea-session-drafts/blob?session=` | attachment bytes → `{ blob, size }` |
| `GET /api/deepsea-session-drafts/file?session=&id=&type=` | attachment bytes |
| `GET /api/deepsea-session-drafts/download?session=&id=&name=` | the draft as `<name>.draft.md` or `<name>.draft.zip`, as an attachment (download.mjs) |

The document is validated against the composer's draft format (reference
spans must match the text, a command token must open it) before it is
stored.

## Configuration

All optional, on the `deepsea-session-drafts` row (a patch replaces the whole `config`):

| Key | Default | Meaning |
|---|---|---|
| `maxDrafts` | `200` | Drafts per session. |
| `maxAttachments` | `32` | Attachments per draft. |
| `maxAttachmentBytes` | `67108864` | Largest attachment (64 MiB). |
| `maxChars` | `500000` | Longest draft text. |

## Limits

- The composer is hidden with a stylesheet rule (a Conversation body that
  contains the Drafts View hides its `[data-composer-seat]`); the harness has
  no per-View composer setting.
- Send needs the composer: it goes through Resume, so a composer that is
  not empty is first saved as a draft, and the message is the composer's
  submission.
- A draft's command chip (`/goal …`) is plain text in the Drafts View and
  becomes a chip again on Resume, while the text still starts with it.
- `@` references cannot be added in the Drafts View.
- A session's drafts stay on disk when the session is deleted; export and
  import of sessions do not carry them.
- Two windows editing one draft at once: the last save wins.

## Development

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm test` covers the store (create, update, reopen, blob collection), the
document and attachment validation, the turn position, and the download
files (Markdown, zip contents, names). `pnpm typecheck`
needs a harness with the `composer-drafts` topic.

In a server: `dsd run release --throwaway-app --scripted --plugins
session-drafts --harness <a commit with composer-drafts>`.
