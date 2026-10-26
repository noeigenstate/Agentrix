# Project thumbnails

Agentrix automatically picks a local image to help identify each project in the grid and keyboard switch hint. The image stays fixed as the project changes. Terminals within a project share its thumbnail; projects without a suitable image keep their original number.

## Manage thumbnails

1. Open **Settings → Appearance → Project thumbnails → Manage…**. The list contains all currently open projects, including SSH projects, with their name, path and image mode. Appearance stays selected in the settings sidebar.
2. Choose **Change…** to preview a candidate or upload an image, then **Save**. **Find again** refreshes candidates without replacing the preview. The project header's **Project image…** menu opens the same editor.
3. **Cancel**, the close button or Escape discards edits. From settings, closing the image editor keeps the project list open. **Back to appearance** returns to the existing appearance controls; choosing another settings category also leaves the list.

| Mode | Behaviour |
| --- | --- |
| Automatic | Choose the highest-ranked candidate for a local project without an image. **Choose automatically again** previews a fresh choice; Save returns the project to automatic mode. |
| Custom | Save an uploaded image or a selected candidate. Automatic selection never replaces it. |
| Number | Save **Restore original** to keep the original number, including after restart. Automatic selection remains off for that project. |

Automatic selection is queued after the window loads and when a local project is added, with at most one automatic attempt per project per app run. If nothing suitable is found, the project keeps its number and can be tried again on the next start. Existing automatic snapshots are not refreshed in the background.

Narrow cards fall back to the original number without changing the saved image or mode. Expanded cards retain the existing sidebar visibility rules. Terminal input, text selection, dragging, splits, session restoration, completion notifications and theme settings keep their existing behaviour.

## Local candidate rules

Candidates use fixed priorities:

1. Icons declared in package, Electron build/Forge or Web App Manifest metadata.
2. Files named like `icon`, `logo` or `favicon`.
3. Local raster images referenced by a README.
4. Existing images in common asset folders.

The list contains at most six distinct images, including at most two icons. Duplicate file contents and thumbnails are removed. README names can have Unicode language suffixes such as `README.中文.md`; HTML image paths support numeric and common named character references.

Scanning covers common asset folders and shallow monorepo packages. Dependency, hidden, cache and generated-output directories are skipped during traversal; explicitly referenced images in a `build` directory can still be read. Directory links and files resolving outside the project are excluded.

Directory, depth, file, byte and decoding budgets bound the scan. Candidate source images are limited to 8 MiB each and 24 MiB total reads; known raster headers are checked before native decoding to reject excessive dimensions. A bounded scan may miss images. It does not run project commands, call a model, fetch URLs or watch files.

- Automatic candidates support PNG, JPEG, WebP, GIF and ICO. SVG, ICNS, animated WebP, remote URLs and README data URLs are skipped.
- SSH projects are not scanned or connected for this feature. They can use an uploaded image from this computer.
- Uploads accept PNG, JPEG, WebP or GIF up to 10 MiB; GIF uses its first frame.

## Storage and compatibility

Images are centred square snapshots at 256 × 256 pixels, stored in the local workspace configuration rather than the project folder. Uploads become WebP; scanned candidates become PNG or, when needed for size, JPEG. A stored image data URL is limited to 200,000 characters. Editing, moving or deleting its source does not change the snapshot.

The optional `Project.image` and `Project.imageMode` fields keep the existing workspace format version. Legacy projects with an image are treated as custom; those without an image default to automatic selection. Invalid saved images are ignored without discarding the workspace. Saving a number removes the image and records the opt-out.

This addition uses the existing image-processing helper and dialog styles. It adds no dependencies and changes no version number or CI workflow.

## Checks

After installing the project's dependencies, build before running the desktop scripts. Run them sequentially; each creates an isolated workspace and fixture projects under `.test-output`.

```sh
npm run build
node --experimental-strip-types --test --test-concurrency=4 tests/*.test.cjs
node scripts/project-image-smoke.mjs
node scripts/project-image-candidates-smoke.mjs
```

The TypeScript flag is needed by the test imports on Node 22; newer Node versions can use the existing `npm test` entry point. The concurrency limit controls local test load and does not change CI.

| Checked-in validation | Windows result for this contribution |
| --- | --- |
| Unit suite | 1,073 passed, 8 skipped for platform or file-symlink permissions |
| Project-image desktop smoke | Passed, including narrow-card numbering, settings navigation and terminal preservation |
| Candidate desktop smoke | Passed, including automatic selection, mode persistence, SSH/manual fallback and source changes |

Supplemental local harnesses also exercised representative combinations in the source app and an unpacked Windows directory build, with real GPU rendering, existing themes, small and expanded views, and 100% / 150% / 200% zoom. Those harnesses are not checked in or covered by the commands above. They were not an exhaustive combination search. The directory build was not installed; macOS/Linux native GUI, installer behaviour and remote CI remain unverified for this contribution.