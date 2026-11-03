function workerEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|SESSION_ACCESS_TOKEN|API_KEY|AUTH)|CLAUDE_(?:OAUTH|AUTH|API_KEY)|AGENTRIX_(?:BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY))/i.test(name)));
}

module.exports = { workerEnvironment };
