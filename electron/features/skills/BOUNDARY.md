# Boundary: Skills

The skills library: built-in, global and project SKILL.md folders with their options, versions, pending proposals and
usage, the instructions each agent session receives about them, and the settings page that shows and edits them.

## Owns
- `electron/features/skills/**`
- `src/features/settings/Skill*.tsx`
- `src/features/settings/skill-*.ts`

## Interface
- `SkillsStore` (`electron/features/skills/store.cjs`) — the library for main: list, read, save, options, history, per-session delivery, usage and folder watching
- `registerSkillsIpc` (`electron/features/skills/ipc.cjs`) — the nine `skills:*` IPC handlers behind the preload skills API
- `nativeSkillActions` (`electron/features/skills/native-actions.cjs`) — feeds SDK and app-server tool reads into the action log so usage is recorded
- `frontMatter` (`electron/features/skills/front-matter.cjs`) — the one front-matter decoder, shared with activity descriptions in agent-actions.cjs
- `skillInstructions` (`electron/features/skills/delivery.cjs`) — the skill instruction text of a delivery, for the startup note in handoff.cjs
- `SSH_REFERENCE_NOTE` (`electron/features/skills/delivery.cjs`) — the SSH reference-copy sentence the startup note repeats
- `plain` (`electron/features/skills/delivery.cjs`) — flattens note text to one TOML-safe line
- `MAX_NOTE` (`electron/features/skills/delivery.cjs`) — the startup note's length budget
- `SkillsSettings` (`src/features/settings/SkillsSettings.tsx`) — the 技能 settings page

## May import
- `src/shared/**`
- `src/features/reading/ReadingView.tsx`
- `electron/agent-actions.cjs`
- `electron/codex-activity.cjs`
- `electron/atomic-write.cjs`

## Invariants
- Built-in skills are read-only: save, delete, revert, accepting a proposal and turning on autoOptimize or confirmChanges are refused — they ship with the app and are replaced on update — test: `tests/skills.test.cjs` › "skill defaults, exact public shape, read-only built-ins and local-only project scopes"
- Built-in ids and names are defined only here, from the shipped folders; no other code (the settings UI included) names a `builtin:` id or a shipped skill name — a hard-coded id breaks silently when a built-in is renamed or added — test: `tests/boundary-skills.test.cjs` › "no code outside the skills backend names a built-in skill id or a shipped built-in name"
- A built-in's defaults, timing and agent requirements come from its front matter, never from its name — a new built-in must work without code changes — test: `tests/builtin-skills.test.cjs` › "defaults, timing and requirements come from front matter for any built-in name"
- Skill folders never escape managed storage: invalid names and symlinks are refused on read, save, import and delete — agents and imported folders supply these paths — test: `tests/skills.test.cjs` › "invalid names, imports and symlinked skill folders cannot escape managed storage"
- An SSH session receives only enabled built-in and global skill text, never project skills or local paths — the remote host must not learn the local machine — test: `tests/skills.test.cjs` › "SSH bundle contains only enabled built-in/global files, never project skills or local paths"
- An agent's proposed change waits in skill-pending and never changes the active file until the user accepts it — confirmChanges is the user's guarantee — test: `tests/skills.test.cjs` › "pending proposals do not change the active file; accept, reject and agent-created review"
- An always or first-open skill's first run is claimed only by an observed agent launch, once per project, and only if enabled, not yielded and included in the delivery — a shell, preview, refresh or later agent in any terminal must not claim it; always stays always afterwards, first-open becomes auto — test: `tests/builtin-skills.test.cjs` › "first run is claimed by an agent, never a shell or refresh"
- lastUsed is recorded only from a successful read of the skill file, never from a mention, a failed read or an unrelated path — the page shows it as fact — test: `tests/skills.test.cjs` › "successful Claude/Codex skill reads record lastUsed, failed/settled/mentioned/unrelated paths do not"

## Not ours
- Scrubbing private data out of skill text — Activity pane (`electron/features/agents/skill-privacy.cjs`)
- Composing the startup note around the skill instructions and its length budget — handoff (`electron/features/agents/handoff.cjs`, unowned)
- The preload skills API and the SkillInfo / SkillDetail types — shared contract (`electron/preload.cjs`, `src/shared/types.ts`, unowned)
- Rendering Markdown — Reading view (`Markdown` in `src/features/reading/ReadingView.tsx`)
- The settings dialog and its other pages — settings shell (`src/features/settings/SettingsDialog.tsx`, unowned)
- Polling and watching files — Completion (`monitorActivity` in `electron/codex-activity.cjs`)
- Parsing agent tool calls into actions — `electron/agent-actions.cjs` (unowned)
- Listing built-in commands in the reading view's command menu — Reading view
