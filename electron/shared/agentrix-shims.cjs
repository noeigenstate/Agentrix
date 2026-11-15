// The folder of Agentrix's own codex and claude shims (C-8) holds this file. A CLI locator never searches a folder that
// holds it: a shim found there would run the dispatcher instead of the CLI it stands for. Plain Node: the dispatch
// helper carries this file.
const SHIM_MARKER = '.agentrix-shims';

module.exports = { SHIM_MARKER };
