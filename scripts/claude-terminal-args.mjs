import assert from 'node:assert/strict';
import path from 'node:path';

export function assertClaudeTerminalArgs(args, label, resumeArgs) {
  const settings = args.indexOf('--settings');
  const note = args.indexOf('--append-system-prompt');
  assert.ok(settings >= 0 && settings + 1 < note, `${label}: hook settings precede the reading note`);
  // The wrapper removes the settings file on exit, so check its name in the recorded argv.
  assert.match(args[settings + 1], /[\\/][\w-]+-claude-settings-(?:[0-9a-f]{32}\.json|[A-Za-z0-9]{6})$/, `${label}: session-owned hook settings file`);
  assert.match(args[note + 1] ?? '', /^You run inside Agentrix/, `${label}: Agentrix reading note`);

  const prefix = '--mcp-config=';
  const configs = args.filter(arg => arg.startsWith(prefix));
  assert.equal(configs.length, 1, `${label}: one inline MCP config for the terminal conversation`);
  const server = JSON.parse(configs[0].slice(prefix.length)).mcpServers?.agentrix;
  assert.equal(server?.type, 'stdio', `${label}: Agentrix role tools use stdio`);
  assert.ok(server.command, `${label}: role tools have a launcher`);
  assert.equal(path.basename(server.args?.[0] ?? ''), 'dispatch.cjs', `${label}: role tools use the dispatch helper`);
  assert.equal(server.args?.[1], 'mcp', `${label}: dispatch runs in MCP mode`);

  if (resumeArgs) {
    const resume = args.indexOf('--resume');
    assert.ok(note + 1 < resume && args.indexOf(configs[0]) < resume, `${label}: reading note and role config precede resume`);
    assert.deepEqual(args.slice(resume), ['--resume', ...resumeArgs], `${label}: resume ID and continuation prompt`);
  }
}
