// Generated from registry.mjs by node tests/cli-adapters.test.cjs --write-worker-manifests.
module.exports = [
  { id: "claude", label: "Claude Code", install: { minVersion: "2.1.317" }, models: { match: /^(opus|sonnet|haiku|fable|claude-)/, prefix: "" } },
  { id: "agy", label: "Antigravity", install: { minVersion: "1.5.18" }, models: { match: /^(agy:|gemini-)/, prefix: "agy:" } },
  { id: "codex", label: "Codex", install: { minVersion: "0.166.0" }, models: { match: /^/, prefix: "" } },
];
