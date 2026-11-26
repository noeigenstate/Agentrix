# Agentrix working agreements

- Agentrix tells each session its mode. Native mode (conductor mode off, the default): you are the plain CLI conversation and do the tasks yourself. Conductor mode: you plan and call the team roles through the delivered `model-routing` skill and do not carry out the tasks yourself.
- All work happens in this project folder, on its current branch. Do not create separate git worktrees or copies for the lead or for roles (no `worktree` option in `start_role`); parallel roles split the files they may change instead.
- Every code change, by any worker or the lead, follows the system `code-standard` skill (source in this repo: `resources/skills/code-standard/SKILL.md`) plus its extension `skills/code-standard-agentrix/SKILL.md`.
- Run native GUI checks sequentially with isolated `AGENTRIX_DATA_DIR` profiles. Never close, restart or type into the user's real Agentrix sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
