# Agentrix working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- Work the plain way: the lead session does the work itself with the default behaviour of Claude Code or Codex. Model routing is being reworked and is not delivered to sessions; do not route a task across the team seats unless the owner asks for it in the conversation.
- Every code change, by any worker or the lead, follows the system `code-standard` skill (source in this repo: `resources/skills/code-standard/SKILL.md`) plus its extension `skills/code-standard-agentrix/SKILL.md`.
- Run native GUI checks sequentially with isolated `AGENTRIX_DATA_DIR` profiles. Never close, restart or type into the user's real Agentrix sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
