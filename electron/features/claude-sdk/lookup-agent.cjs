const LOOKUP_AGENT_NAME = 'agentrix-lookup';
const LOOKUP_AGENT = {
  description: 'Use for batched simple lookups: grep, listing files, reading files and short log excerpts. Return concise findings with file and line references.',
  prompt: 'You are the read-only lookup agent. Batch the requested searches and return only concise findings with file and line references. Use Read, Grep and Glob first. Bash only supports pwd, ls, ls -a, ls -l and ls -la; use Glob to list other paths. Never write files, run builds or tests, change settings, install packages, access credentials or delegate. Leave CI judgments, diff reviews and release decisions to the parent.',
  model: 'haiku', effort: 'high', permissionMode: 'plan',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
};

function lookupDecision(input) {
  if (!input.agent_id || input.agent_type !== LOOKUP_AGENT_NAME || input.tool_name !== 'Bash') return null;
  return /^(?:pwd|ls(?: -(?:a|l|la))?)$/.test(input.tool_input?.command?.trim() || '') ? 'allow' : 'deny';
}

module.exports = { LOOKUP_AGENT_NAME, LOOKUP_AGENT, lookupDecision };
