# Boundary: Skills

The skills library: built-in, global and project skills, their options, history and proposals, session instruction delivery, and the settings page that edits them.

## Owns
- `electron/features/skills/**`
- `src/features/settings/Skill*.tsx`
- `src/features/settings/skill-*.ts`

## Interface
- `SkillsStore` (`electron/features/skills/store.cjs`) — library operations, watching, current project/agent manifests, launch snapshots and injected routingNote(); local `<sessionManifest>.json` carries fingerprint, projectRoot and managed roots, and SSH creates equivalent metadata using bundle.key after remote path expansion
- `registerSkillsIpc` (`electron/features/skills/ipc.cjs`) — the nine skills IPC handlers
- `nativeSkillActions` (`electron/features/skills/native-actions.cjs`) — records successful SDK and app-server skill reads
- `frontMatter` (`electron/features/skills/front-matter.cjs`) — the shared front-matter decoder
- `skillInstructions` (`electron/features/skills/delivery.cjs`) — delivery text; also exports SSH_REFERENCE_NOTE, plain and MAX_NOTE for startup notes
- `SkillsSettings` (`src/features/settings/SkillsSettings.tsx`) — the skills settings page
- `sessionContext` (`electron/features/skills/session.cjs`) — fingerprinted SessionStart delivery and per-CLI receipts; also exports deliveryMarker, readDelivery and digest for the hook and startup note
- `WorkerSkillProposals` (`electron/features/skills/worker-proposals.cjs`) — snapshots project and trusted managed skill roots, preserves proposals beside the answer, then restores unapproved changes

## May import
- `src/shared/**`
- `src/features/reading/ReadingView.tsx`
- `electron/agent-actions.cjs`
- `electron/codex-activity.cjs`
- `electron/atomic-write.cjs`
- `electron/boundaries.cjs`

## Invariants
- Built-in skills refuse save, delete, revert, accepting proposals and optimization options — shipped files are read-only and replaced on update — test: `tests/skills.test.cjs` › "skill defaults, exact public shape, read-only built-ins and local-only project scopes"
- Built-in ids and names are defined only here; defaults, timing and requirements come from front matter — new built-ins must work without code changes or names hard-coded by callers — test: `tests/boundary-skills.test.cjs` › "no code outside the skills backend names a built-in skill id or a shipped built-in name"; test: `tests/builtin-skills.test.cjs` › "defaults, timing and requirements come from front matter for any built-in name"
- Skill folders never escape managed storage; invalid names and symlinks are refused on read, save, import and delete — agents and imports supply these paths — test: `tests/skills.test.cjs` › "invalid names, imports and symlinked skill folders cannot escape managed storage"
- SSH receives only enabled built-in/global text and optional adopted routing weights, never project skills or local paths — remote copies stay private to the remote session and weights stay outside committed files — test: `tests/skills.test.cjs` › "SSH bundle contains only enabled built-in/global files, never project skills or local paths"; test: `tests/skills-session.test.cjs` › "routing note is optional, current on a new delivery and included in bounded SSH manifests"
- User-confirmed proposals wait in skill-pending; workers need a literal allowed SKILL.md path to apply an edit, and broad globs preserve proposals then restore pre-run bytes — the user and lead retain their respective approval controls — test: `tests/skills.test.cjs` › "pending proposals do not change the active file; accept, reject and agent-created review"; test: `tests/dispatch-skill-proposals.test.cjs` › "broad scope restores edited/new/deleted skills and preserves worker versions beside the answer"
- Always/first-open first runs are claimed only by an observed launch, once per project, enabled and actually delivered; always stays always and first-open becomes auto — shells, previews and later agents cannot consume the first run — test: `tests/builtin-skills.test.cjs` › "first run is claimed by an agent, never a shell or refresh"
- lastUsed records only a successful skill-file read, never a mention, failed read or unrelated path — the page shows usage as fact — test: `tests/skills.test.cjs` › "successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not"
- Claude startup/resume deduplicate actual CLI session plus launch fingerprint and compact/clear force delivery; Codex's replayed note keeps a current project/agent manifest across terminal exits and app restarts, with immutable launch snapshots for first-run details, removed only with the project — instructions already in context are reused and owner prompts are never rewritten — test: `tests/skills-session.test.cjs` › "startup/resume deduplicate CLI session plus content fingerprint, compact/clear always deliver"; test: `tests/skills-session.test.cjs` › "Codex resume keeps the current project manifest across terminal exits and app restarts"

## Not ours
- Scrubbing private data from skill text — Activity pane (skill-privacy.cjs)
- Composing the startup note and its length budget — handoff (electron/features/agents/handoff.cjs)
- Preload skills API and shared skill types — shared contract
- Markdown rendering and built-in commands in the reading menu — Reading view
- Settings dialog and other pages — Settings shell
- Polling and watching files — Completion (monitorActivity)
- Parsing tool calls into actions — electron/agent-actions.cjs
- Forwarding the owner's unmodified prompts and PTY keys — Terminal input
