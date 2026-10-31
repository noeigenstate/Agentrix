// Local deterministic protocol stand-in, never an upstream proxy. No credentials are logged or loaded.
const http = require('node:http');
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
function createStandin({ scenario = 'approval' } = {}) {
  let requests = 0, questionSchema;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', bytes => { body += bytes; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}'), id = `local_${++requests}`;
        if (req.method !== 'POST') { res.writeHead(404).end(); return; }
        if (/\/responses(?:\?.*)?$/.test(req.url)) {
          const input = data.input || [], hasResult = input.some(item => /output$/.test(item.type || '') && String(item.call_id || '').startsWith('call_local_'));
          const marker = JSON.stringify(input).includes('NATIVE_REQUEST_PROBE');
          const item = marker && !hasResult ? { type: 'custom_tool_call', id: `ct_${id}`, call_id: `call_${id}`, namespace: 'functions', name: 'exec',
            input: 'await tools.exec_command({cmd:"echo native-request-probe",sandbox_permissions:"require_escalated",justification:"Local native identity probe: deny this harmless command"});' }
            : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'Local stand-in finished.' }] };
          const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: null, output_tokens_details: null } } }];
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(events)); return;
        }
        if (/\/messages(?:\?.*)?$/.test(req.url)) {
          const hasResult = (data.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'tool_result'));
          const tool = (data.tools || []).find(tool => tool.name === (scenario === 'question' ? 'AskUserQuestion' : scenario === 'elicitation' ? 'mcp__native_probe__request_input' : 'Bash'));
          if (scenario === 'question' && tool) questionSchema = tool.input_schema;
          const useTool = !!tool && !hasResult;
          const block = useTool ? { type: 'tool_use', id: `tool_${id}`, name: tool.name, input: {} } : { type: 'text', text: '' };
          const events = [{ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: block },
            { type: 'content_block_delta', index: 0, delta: useTool ? { type: 'input_json_delta', partial_json: JSON.stringify(scenario === 'question'
              ? { questions: [{ question: 'Choose a local probe option', header: 'Probe', options: [{ label: 'One', description: 'First option' }, { label: 'Two', description: 'Second option' }], multiSelect: false }] }
              : scenario === 'elicitation' ? {} : { command: 'printf controlled > native-proof.txt', description: 'Local native identity probe; deny this harmless command' }) } : { type: 'text_delta', text: 'Local stand-in finished.' } },
            { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
          if (!data.stream) { res.writeHead(400).end('This stand-in supports streaming only'); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(events)); return;
        }
        if (/\/messages\/count_tokens/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
        res.writeHead(404).end();
      } catch { res.writeHead(400).end(); }
    });
  });
  return { server, get requests() { return requests; }, get questionSchema() { return questionSchema; } };
}
module.exports = { createStandin };
