# Boundary: Skills

The skills library: built-in, global and project skills, their options, history and proposals, session instruction delivery, and the settings page that edits them.

Routing saves roles and operation choices together. A conversation freezes role metadata, seats, operation choices and rendered instructions when it starts.
A project file can contain short custom duty and output text. Its author can write misleading prose within those limits, so applying an external edit requires owner confirmation.
The same snapshot carries a launch map with Claude Agent aliases resolved against the catalog at launch time.

## Owns
- `electron/features/skills/**`
- `src/features/settings/Skill*.tsx`
- `src/features/settings/skill-*.ts`

## Interface
- `familyOf` (`electron/features/skills/seat-rules.mjs`) — shared model family, rank, effort lists, validation and Claude operation environment allowlist.
- `authorIdentityConflict` (`electron/features/skills/role-rules.mjs`) — shared role validation, limits, kinds and reviewer independence.
- `SkillsStore` (`electron/features/skills/store.cjs`) — skill library, project routing, launch manifests, frozen sessionRoles, catalog observation and model probes.
- `registerSkillsIpc` (`electron/features/skills/ipc.cjs`) — skills IPC handlers, including routing reads, saves and confirmation actions
- `seatHookOutput` (`electron/features/skills/agent-seat.cjs`) — model and effort rewrite and provisional report for a declared Claude seat. `observedAgentSeat` supplies final input.
- `probeCodex` (`electron/features/skills/model-probe.cjs`) — also exports probeClaude; injected, bounded model-only probes, without creating a thread or submitting input; Claude uses no setting sources and persists no session. Main supplies the Codex RPC factory, process-tree stop and environment scrubber, and the Claude SDK loader, so Skills imports neither provider. Cleanup runs on success, failure and deadline, and late executable/SDK resolution cannot start a process.
- `nativeSkillActions` (`electron/features/skills/native-actions.cjs`) — records successful SDK and app-server skill reads
- `frontMatter` (`electron/features/skills/front-matter.cjs`) — the shared front-matter decoder
- `skillInstructions` (`electron/features/skills/delivery.cjs`) — delivery text; also exports SSH_REFERENCE_NOTE, plain and MAX_NOTE for startup notes
- `SkillsSettings` (`src/features/settings/SkillsSettings.tsx`) — the skills settings page
- `sessionContext` (`electron/features/skills/session.cjs`) — skill-manifest-only SessionStart context and per-CLI receipts; also exports deliveryMarker (local fingerprint/path or SSH split marker), readDelivery and digest for the hook and startup note
- `WorkerSkillProposals` (`electron/features/skills/worker-proposals.cjs`) — snapshots project and trusted managed skill roots, preserves proposals beside the answer, restores only an isolated worker worktree and reports shared changes with unknown authorship; snapshot limits degrade to report-only

## May import
- `electron/features/agents/call-seat.cjs` (parse the same description prefix the Agent tab recognises)
- `src/shared/types.ts`
- `src/shared/i18n.ts`
- `src/shared/IconButton.tsx`
- `src/shared/Select.tsx`
- `src/shared/routing-command.ts`
- `src/shared/time.ts`
- `src/features/reading/ReadingView.tsx`
- `electron/agent-actions.cjs`
- `electron/codex-activity.cjs`
- `electron/atomic-write.cjs`
- `electron/boundaries.cjs`

## Invariants
- Built-in skill IDs and names live in Skills. — test: `tests/boundary-skills.test.cjs` › "no code outside the skills backend names a built-in skill id or a shipped built-in name"
- Only the accepted digest applies a project file. — test: `tests/project-routing.test.cjs` › "trust states select exactly one fallback and reject unavailable invalid-file actions"
- Skill folders never escape managed storage; invalid names and symlinks are refused on read, save, import and delete — agents and imports supply these paths — test: `tests/skills.test.cjs` › "invalid names, imports and symlinked skill folders cannot escape managed storage"
- SSH receives only enabled built-in/global text and optional adopted routing weights, never project skills or local paths — remote copies stay private to the remote session and weights stay outside committed files — test: `tests/skills.test.cjs` › "SSH bundle contains only enabled built-in/global files, never project skills or local paths"; test: `tests/skills-session.test.cjs` › "routing note is optional, current on a new delivery and included in bounded SSH manifests"
- User-confirmed proposals wait in skill-pending; workers need a literal allowed SKILL.md path to apply an edit, and broad globs preserve proposals then restore pre-run bytes only in an isolated worker worktree; managed and shared changes remain live with unknown authorship — the user and lead retain their respective approval controls — test: `tests/skills.test.cjs` › "pending proposals do not change the active file; accept, reject and agent-created review"; test: `tests/dispatch-skill-proposals.test.cjs` › "broad scope restores edited/new/deleted skills and preserves worker versions beside the answer"; test: `tests/dispatch-skill-proposals.test.cjs` › "concurrent owner edits to global and built-in skills are report-only, unrelated inherited deliveries are ignored"
- An enabled skill's first run is claimed only by an observed launch, once per project, when the skill is delivered. Starts under `always` claim it as before. The separate `firstOpenRun` flag gives an `auto` skill the first-run instruction. A saved `first-open` trigger migrates to `auto` with the flag set — test: `tests/builtin-skills.test.cjs` › "first run is claimed by an agent, never a shell or refresh"
- lastUsed records only a successful skill-file read, never a mention, failed read or unrelated path — the page shows usage as fact — test: `tests/skills.test.cjs` › "successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not"
- Launch role metadata and choices stay frozen through edits and compact/clear. — test: `tests/skills.test.cjs` › "pending routing retains accepted settings and freezes launched roles through edits"

## Not ours
- Scrubbing private data from skill text — Activity pane (skill-privacy.cjs)
- Composing the startup note and its length budget — handoff (electron/features/agents/handoff.cjs)
- Preload skills API and shared skill types — shared contract
- Markdown rendering and built-in commands in the reading menu — Reading view
- Settings dialog and other pages — Settings shell
- Polling and watching files — Completion (monitorActivity)
- Parsing tool calls into actions — electron/agent-actions.cjs
- Forwarding the owner's unmodified prompts and PTY keys — Terminal input
