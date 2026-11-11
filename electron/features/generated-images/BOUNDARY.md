# Boundary: Generated pictures

A picture a native Codex session generated: shown in the conversation (read back over SSH for a remote project) and
copied into the project's generated-images folder. Runs in the main process; the remote half is
`generated_image` / `generated_copy` in integration/remote-worker.py.

## Owns
- `electron/features/generated-images/**`

## Interface
- `createGeneratedImages` (`electron/features/generated-images/generated-images.cjs`) — render(item, spec, mode) and settle(item, spec, mode), the Codex runtime's renderImage and settleImage; also exports projectCopy, remoteImage (a picture on an SSH project's computer, read back whole) and rawPicture (a WebP picture's own bytes as a data URL)

## May import
- `electron/generated-image-path.cjs`
- `electron/features/files/file-cards.cjs` (isImageFile, and remoteImageBytes with the remote image limit it reads by)
- `electron/features/files/preview-location.cjs` (the refusal of a path outside an SSH project)

## Invariants
- A copy is made only in the project's registered folder's generated-images, by an exclusive create under the picture's own name or the next free number, and is found again by size and SHA-256; looking for a copy writes nothing, and a generated-images that is a link or junction is refused — a copy must never replace a file or write outside the project — test: `tests/generated-images.test.cjs` › "a generated picture is copied once into the project generated-images, a different one of its name under the next number, nothing replaced"
- An SSH picture is read back only through the worker's generated-image read (its Codex home's generated_images) or from inside the project root, in 256 KiB pages and at most 16 MB — the popup and the save must not become a reader of the remote computer's files — test: `tests/generated-images.test.cjs` › "an SSH picture is read back in 256 KiB pages: a generated one through the generated-image read, a project one inside the project only, at most 16 MB"
- Picture jobs run at most two at a time per SSH connection, and on this computer; a resumed conversation reads back only its six newest pictures and the older ones on request — a long conversation must not fill the connection's 64 pending requests or the worker's four threads, which the session's input needs — test: `tests/generated-images.test.cjs` › "a resumed SSH conversation with 40 pictures keeps at most two picture requests in flight, reads back only its six newest and leaves codex-input prompt"
- A picture's later facts replace its item under the same id only while that copy is still the newest and the session is open; only a picture completed in this process is copied, never replayed history — history must not copy a picture again — test: `tests/generated-images.test.cjs` › "a native picture shows at once, then its read-back and project copy replace it under the same item; history only finds its copy, a closed session gets nothing late"
- A failed copy is said by its kind (no permission, read-only disk, disk full) and never names a path; only a file the copy itself created is removed — a refusal must not leak where things are or delete the owner's files — test: `tests/generated-images.test.cjs` › "a copy that fails says why under the picture; a local picture keeps its preview and gains its copy"
- Residual, local only: Node has no folder descriptors, so a generated-images replaced by a junction between its check and the exclusive create could receive the copy; the SSH worker creates through a descriptor opened without following links and has no such window — test: `tests/remote_worker_test.py` › "test_generated_pictures_are_read_under_codex_home_and_copied_only_into_generated_images"

## Not ours
- Reading and showing project files and their cards — File previews (electron/features/files)
- Publishing items and replaying history — Codex app-server runtime (electron/features/codex-app-server)
- The reply link, the tree reveal and the picture popup — Reading view and src/features/files
- What the remote worker checks before reading or writing — integration/remote-worker.py
