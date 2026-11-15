// The folder of Agentrix's own codex and claude shims (C-8) holds this file. A CLI locator never searches a folder that
// holds it: a shim found there would run the dispatcher instead of the CLI it stands for. Plain Node: the dispatch
// helper carries this file.
const SHIM_MARKER = '.agentrix-shims';
// The folder of a stand-in CLI that Agentrix's own tests build (scripts/gui-codex-env.mjs) holds this file. The Codex
// drive scan never takes a file there: the stand-in answers --version as Codex does.
const STAND_IN_MARKER = '.agentrix-stand-in';

module.exports = { SHIM_MARKER, STAND_IN_MARKER };
