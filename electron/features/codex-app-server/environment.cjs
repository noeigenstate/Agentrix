function workerEnvironment(env) {
  const sdkParent = env.AGENTRIX_SDK_PARENT === '1';
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^AGENTRIX_(?:SDK_PARENT|BOOTSTRAP|CONTROL|CAPABILITY|.*SESSION_KEY)/i.test(name)
    && !/^CLAUDE_CODE_ENTRYPOINT$/i.test(name)
    && !(sdkParent && /^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH|USE_|SESSION_ACCESS_TOKEN|API_KEY|AUTH)|CLAUDE_(?:OAUTH|AUTH|API_KEY))/i.test(name))));
}

module.exports = { workerEnvironment };
