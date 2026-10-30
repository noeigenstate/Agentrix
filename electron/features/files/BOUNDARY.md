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
- Outside UNC, device and hosted file URLs are rejected before filesystem access — a new grant must not initiate SMB authentication — test: `tests/files-preview-security.test.cjs` › "outside UNC and device previews are rejected before filesystem operations"
- Outside page resources have offline CSP and the popup rejects external navigation — page scripts must not send file content out — test: `tests/files-preview-security.test.cjs` › "outside previews have offline CSP and popup navigation cannot escape the local preview"
- Outside captures reuse a private non-persistent session with request filtering and disable_non_proxied_udp WebRTC policy; the idle session denies requests — automatic card capture must not contact a host or accumulate sessions — test: `tests/files-preview-security.test.cjs` › "outside captures reuse an offline session, restrict WebRTC and deny network and foreign preview requests"
- Local pictures are checked against header dimensions and 25 MB before decoding and cached by file version; JPEG metadata scanning skips segment payloads and stops at 4 MiB or 1024 segments — replay must not repeatedly decode unbounded images — test: `tests/files-preview-thumbnails.test.cjs` › "JPEG thumbnails find SOF after 64 KiB with bounded segment reads, including file cards"
- A project's own UNC or mapped root remains usable for previews and does not mint outside grants — the existing project boundary authorizes its share — test: `tests/files-preview-security.test.cjs` › "UNC-rooted and mapped projects preview their own HTML and video without granting outside UNC access"
- Home/AppData, Library, .config, .local, APPDATA/LOCALAPPDATA and XDG_CONFIG_HOME/XDG_DATA_HOME trees, and folders named .aws, .azure, .ssh, .gnupg, .kube, .password-store, gcloud, keyrings or credentials grant only the selected outside file — application data and credential stores must not become page assets — test: `tests/files-preview-security.test.cjs` › "application-data and credential-store folders grant only the selected outside file"

## Not ours
- Human-message provenance, Codex pairing and transcript decoding — conversation.cjs and oversized-record.cjs
- Popup rendering and navigation guard — src/features/files and electron/app/window-events.cjs; popups share the main session and retain its WebRTC policy, a known residual: offline CSP blocks network resources but does not govern STUN/TURN
- Opening-project list and PreviewResources construction — electron/main.cjs
- Token resource responses and range streaming — electron/preview-resources.cjs
