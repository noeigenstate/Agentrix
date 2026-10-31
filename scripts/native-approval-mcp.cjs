// Loopback probe's MCP server. Its only tool requests a form; it cannot read or write files.
const { createInterface } = require('node:readline');
const pending = new Map(); let sequence = 0;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const form = { type: 'object', properties: { name: { type: 'string', minLength: 1 }, approved: { type: 'boolean' } }, required: ['name', 'approved'] };
createInterface({ input: process.stdin }).on('line', line => {
  if (Buffer.byteLength(line) > 256 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  let message; try { message = JSON.parse(line); } catch { return; }
  const id = message.id;
  if (pending.has(id) && !message.method) {
    const original = pending.get(id); pending.delete(id);
    send({ id: original, result: { content: [{ type: 'text', text: JSON.stringify(message.result || { action: 'cancel' }) }] } }); return;
  }
  if (message.method === 'initialize') send({ id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'native-probe', version: '1' } } });
  if (message.method === 'tools/list') send({ id, result: { tools: [{ name: 'request_input', description: 'Request a local probe form with no side effects', inputSchema: { type: 'object', properties: {} } }] } });
  if (message.method === 'tools/call') {
    const request = `probe-form-${++sequence}`; pending.set(request, id);
    send({ id: request, method: 'elicitation/create', params: { mode: 'form', message: 'Complete the local probe form', requestedSchema: form } });
  }
});
