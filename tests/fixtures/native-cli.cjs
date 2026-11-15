// Harmless stand-in executable. It never loads CLI accounts or calls a model/network service.
// Stand-in contract (tests/fake-cli-contract.test.cjs): --version answers at once and writes nothing; AGENTRIX_STAND_IN_ECHO names the file that gets the arguments, --settings and hooks it was given.
if (process.env.AGENTRIX_STAND_IN_ECHO) require('./stand-in-echo.cjs')();
if (process.argv.includes('--version')) { console.log(process.argv.includes('app-server') ? 'codex-cli 0.166.0' : '2.1.317 (Claude Code)'); process.exit(0); }
const readline = require('node:readline');
const codex = process.argv.includes('app-server');
let sequence = 0;
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (codex) {
    if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'stand-in' } });
    else if (message.method === 'fixture/emit') for (const value of message.params) emit(value);
    else if (message.method === 'fixture/raw') process.stdout.write(message.params);
    else if (message.method === 'fixture/exit') process.exit(0);
    else if (!message.method && Object.hasOwn(message, 'id')) emit({ method: 'fixture/received', params: message });
  } else {
    if (message.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    if (message.type === 'user') emit({ type: 'control_request', request_id: `cli-fixture-${++sequence}`, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: `tool-${sequence}`, input: { command: message.message.content } } });
    if (message.type === 'control_response') {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(message) }] } });
      emit({ type: 'result', session_id: 'stand-in-session', uuid: `turn-${sequence}`, is_error: false });
    }
  }
});
