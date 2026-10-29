# Agentrix working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- Route every task by `skills/model-routing/SKILL.md` automatically, before doing any of it and without being asked: the lead orchestrates; Opus 5.5 (architect) plans; GPT-6.1-Sol (core engineer) takes complex code, refactors, debugging and test fixes in worktree A; a Sonnet 5.5 subagent (execution engineer) takes routine features, front end, tests and docs in worktree B; GPT-6.1-Terra (visual and verification engineer) takes UI checks and small tasks; the lead integrates and runs the tests; an Opus 5.5 subagent reviews the architecture and GPT-6.1-Terra accepts the UI and interaction; then final acceptance. GPT models always run at max effort in fast mode, Claude models at high effort. A worker never delegates further.
- Every code change, by any worker or the lead, follows `skills/code-standard/SKILL.md`; the lead reviews each worker's diff against it before accepting.
- Review is stage 4 of `model-routing` (Opus architecture review + Terra UI acceptance); do not add other reviewer workflows.
- Run native GUI checks sequentially with isolated `AGENTRIX_DATA_DIR` profiles. Never close, restart or type into the user's real Agentrix sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
