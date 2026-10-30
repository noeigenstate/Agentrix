# Boundary: File previews

Resolves local and remote file cards, serves tokenized read-only preview resources, captures HTML and bounds picture thumbnails.

## Owns
- `electron/features/files/**`

## Interface
- `registerFilesIpc` (`electron/features/files/ipc.cjs`) — file operations and preview IPC registration
- `createFileCards` (`electron/features/files/file-cards.cjs`) — document/page/video/image cards; also exports cardKind, isImageFile, inside and documentText
- `createPageCapture` (`electron/features/files/capture-page.cjs`) — sandboxed HTML capture with a private offline session for outside pages
- `createEditorGuard` (`electron/features/files/editor-guard.cjs`) — coordinates confirmation before edits close
- `previewLocation` (`electron/features/files/preview-location.cjs`) — canonical preview location, folder grant policy and local path validation
- `PictureThumbnails` (`electron/features/files/picture-thumbnail.cjs`) — bounded version/hash thumbnail cache and header dimension checks

## May import
- `electron/project-files.cjs`
- `electron/project-paths.cjs`
- `electron/terminal-links.cjs`
- `electron/preview-resources.cjs`
- `electron/oversized-record.cjs`

## Invariants
- Outside folder grants at filesystem roots, home and protected ancestors serve only the selected file; the live project getter also restricts existing grants — private files must not become page assets — test: `tests/files-preview-security.test.cjs` › "outside grants at home, filesystem roots, ancestors and open-project ancestors serve only the selected file"
- Project junctions that leave the project remain refused — a link must not mint an outside grant — test: `tests/files-preview-outside.test.cjs` › "a project junction escaping its root is refused, and replacing an authorized folder revokes access"
- UNC paths are rejected before filesystem access — resolving an agent-supplied host must not initiate SMB authentication — test: `tests/files-preview-security.test.cjs` › "UNC and extended UNC previews are rejected before filesystem operations"
- Outside page resources have offline CSP and the popup rejects external navigation — page scripts must not send file content out — test: `tests/files-preview-security.test.cjs` › "outside previews have offline CSP and popup navigation cannot escape the local preview"
- Outside captures use an isolated session that rejects network and foreign preview requests — automatic card capture must not contact a host — test: `tests/files-preview-security.test.cjs` › "outside captures use a private session and deny all network and foreign preview requests"
- Local pictures are checked against header dimensions and 25 MB before decoding and cached by file version — replay must not repeatedly decode unbounded images — test: `tests/files-preview-thumbnails.test.cjs` › "local thumbnails are version-cached and dimensions and 25 MB limit are checked before decoding"

## Not ours
- Human-message provenance, Codex pairing and transcript decoding — conversation.cjs and oversized-record.cjs
- Popup rendering and navigation guard — src/features/files and electron/app/window-events.cjs
- Opening-project list and PreviewResources construction — electron/main.cjs
- Token resource responses and range streaming — electron/preview-resources.cjs
