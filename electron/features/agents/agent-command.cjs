const path = require('node:path');

// The portable helper uses the routing predicates alone. Resolve the registry only for terminal commands in main.
const terminalOf = agent => require(path.join(__dirname, '../cli-adapters/registry.cjs')).adapterOf(agent)?.terminal;

const ROUTING_MESSAGE = '模型由模型路由决定，请在模型路由中更改。';
const routingCommand = name => ['model', 'effort', 'fast'].includes(name);
const routingText = text => typeof text === 'string' && /^\/(?:model|effort|fast)(?:\s|$)/.test(text.trim());
const routingPatch = patch => ['model', 'effort', 'fast'].some(key => Object.hasOwn(patch, key));
const routingOwned = () => Object.assign(new Error(ROUTING_MESSAGE), { code: 'routing-owned' });

// The command when this run is one of these, else null (a conversation, new or resumed).
function agentCommand(agent, word) {
  if (typeof word !== 'string' || !/^-{0,2}[A-Za-z][A-Za-z-]{0,23}$/.test(word)) return null;
  return terminalOf(agent)?.command?.(word) ?? null;
}

const codexLaunch = args => terminalOf('codex').launch(args, routingOwned);

module.exports = { agentCommand, codexLaunch, routingCommand, routingText, routingPatch, routingOwned };
