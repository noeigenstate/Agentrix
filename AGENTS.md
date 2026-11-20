# Agentrix working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- The lead session is the Orchestrator and decides by its own judgment how each task is staffed, ordered and checked. The team seats set in Agentrix's model routing (Product, Architect, Designer, Developer, Reviewer, QA, Researcher, DevOps, Security and any added roles) are a toolbox: the Orchestrator calls the ones a task needs, or does the work itself; no seat, stage or meeting is mandatory (system `model-routing` skill, source in this repo: `resources/skills/model-routing/SKILL.md`). Seats decide each called worker's model, effort and fast setting; an explicit instruction from the owner in the conversation wins for that task. A worker never delegates further.
- Every code change, by any worker or the lead, follows the system `code-standard` skill (source in this repo: `resources/skills/code-standard/SKILL.md`) plus its extension `skills/code-standard-agentrix/SKILL.md`.
- Run native GUI checks sequentially with isolated `AGENTRIX_DATA_DIR` profiles. Never close, restart or type into the user's real Agentrix sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
