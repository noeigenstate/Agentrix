# Boundary: Intercept

Local planner tool-shell calls to Codex exec and Claude print mode enter the existing dispatcher through PATH shims. Interactive owner shell functions keep their real CLI path.

## Owns
- `integration/shims/**`

## Interface
- `mapCommand` (`integration/shims/intercept.cjs`) — the C-8 whitelist, structured options or a named refusal before admission.
- `intercept` (`integration/shims/intercept.cjs`) — map a CLI call, invoke the existing helper with source intercepted, keep reports on stderr and print the final message only.
- `withShims` (`integration/shims/intercept.cjs`) — clone an environment, prepend the installed shim folder once and set depth plus the worker's opaque run identity; depth zero removes worker identity.
- `runtimeFiles` (`integration/shims/intercept.cjs`) — the Node-only intercept module and a CJS envelope of the six source launchers and marker; shimFiles reads the same source assets for packaging.

## May import
- `integration/dispatch.cjs` (the helper's public run function)

## Invariants
- A planner's mappable codex exec or Claude print call enters the existing helper with source intercepted; unsupported options are refused by name before execution, with an equivalent command when the remaining options map — test: `tests/dispatch-intercept.test.cjs` › "an unsupported option is refused by name with the equivalent command and exit code 2"; test: `tests/dispatch.test.cjs` › "a dispatched CLI inherits shim depth and signed identity while its declaration keeps intercepted".
- An interactive owner wrapper resolves a real CLI outside the shim folder; both locators exclude a folder containing .agentrix-shims — test: `tests/dispatch-intercept.test.cjs` › "interactive wrappers read bootstrap shims and keep real CLI lookup outside that folder"; test: `tests/codex-runtime-guards.test.cjs` › "the Agentrix shim folder is never a locator candidate, for Claude or Codex".
- A worker at depth one or greater cannot launch another CLI through a shim; its refusal names intercept_nested and the future delegate request — test: `tests/dispatch-intercept.test.cjs` › "at depth one or with invalid depth a worker call is refused before stdin or dispatch".
- Stdout carries only the final message, stderr carries dispatcher reports, and exit status is zero for success, one for failure and two for refusal — test: `tests/dispatch-intercept.test.cjs` › "a rerouted stdin call uses the helper, declares intercepted, and prints only its final message"; test: `tests/dispatch-intercept.test.cjs` › "helper failures become exit one and cannot mix dispatch reports into stdout".
- The carried launcher envelope contains the same six source launchers and marker, with CJS names that preserve the SSH transport contract; remote shim activation remains deferred — test: `tests/boundary-dispatch.test.cjs` › "the carried intercept runtime includes the six launchers in a CJS envelope".
- Owner environments start at depth zero and discard an inherited worker identity; worker environments hold a per-run HMAC proof without the reporting credential — test: `tests/dispatch-intercept.test.cjs` › "withShims preserves the caller environment and sets one PATH, depth and opaque run identity"; test: `tests/dispatch.test.cjs` › "a dispatched CLI inherits shim depth and signed identity while its declaration keeps intercepted".

## Not ours
- Admission, run execution, authenticated registration and durable events — Dispatch.
- Host-authoritative lead mode and billing — Native session router.
- Hook sub-agent signals and AgentCall item production — Activity pane and Terminal events.
- Rendering the intercepted tag — Sub-agent view.
- Installing remote SSH shims and delegation — later lanes.
