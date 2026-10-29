const http = require('node:http');
const { randomUUID } = require('node:crypto');

const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const instructionsOf = data => [data.instructions, data.system,
  ...(Array.isArray(data.input) ? data.input : []).filter(item => ['system', 'developer'].includes(item.role)),
  ...(data.messages || []).filter(item => ['system', 'developer'].includes(item.role))].filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n');

// A loopback-only model. Capture instruction fields, never headers/credentials or a CLI's whole prompt.
function createSkillsModel() {
  const requests = [], results = new Set();
  let skillPath = '', reads = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      try {
        const data = JSON.parse(body || '{}'), id = `skills_${randomUUID()}`;
        if (request.method !== 'POST') { response.writeHead(404).end(); return; }
        if (/\/messages\/count_tokens/.test(request.url)) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
        const agent = /\/responses(?:\?.*)?$/.test(request.url) ? 'codex' : /\/messages(?:\?.*)?$/.test(request.url) ? 'claude' : null;
        if (!agent) { response.writeHead(404).end(); return; }
        requests.push({ agent, instructions: instructionsOf(data) });
        const input = agent === 'codex' ? data.input || [] : data.messages || [];
        const marker = JSON.stringify(input).includes('AGENTRIX_SKILLS_PROBE');
        const result = agent === 'codex' ? input.find(item => /output$/.test(item.type || '') && String(item.call_id || '').startsWith('call_skills_'))
          : input.flatMap(item => Array.isArray(item.content) ? item.content : []).find(block => block.type === 'tool_result' && String(block.tool_use_id).startsWith('tool_skills_'));
        if (result && !result.is_error && /name\s*:/.test(JSON.stringify(result))) results.add(agent);
        if (agent === 'codex') {
          const cmd = process.platform === 'win32' ? `Get-Content -LiteralPath '${skillPath.replace(/'/g, "''")}'` : `cat '${skillPath.replace(/'/g, "'\\''")}'`;
          const useTool = marker && !result;
          const item = useTool ? { type: 'custom_tool_call', id: `ct_${id}`, call_id: `call_${id}`, namespace: 'functions', name: 'exec', input: `text(await tools.exec_command(${JSON.stringify({ cmd })}));` }
            : { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'Local skill read finished.' }] };
          if (useTool) reads++;
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse([
            { type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
            { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: null, output_tokens_details: null } } },
          ]));
          return;
        }
        const tool = (data.tools || []).find(item => item.name === 'Read');
        const useTool = marker && !result && !!tool;
        const block = useTool ? { type: 'tool_use', id: `tool_${id}`, name: tool.name, input: {} } : { type: 'text', text: '' };
        if (useTool) reads++;
        const events = [
          { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: data.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: block },
          { type: 'content_block_delta', index: 0, delta: useTool ? { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: skillPath }) } : { type: 'text_delta', text: 'Local skill read finished.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(events));
      } catch { response.writeHead(400).end(); }
    });
  });
  return { server, requests, results, setSkill(file) { skillPath = file.replace(/\\/g, '/'); }, get reads() { return reads; } };
}

module.exports = { createSkillsModel, instructionsOf };
