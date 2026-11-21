const http = require('node:http');
const { hookResponse } = require('./hook-response.cjs');

// agent-event.cjs reads a command hook's input up to the same size.
const BODY_LIMIT = 4 * 1024 * 1024;

// POST /h/<terminalId>/<EventName>, the URL hook-channel.cjs gives a terminal's hooks, or null.
function targetOf(request) {
  const match = request.method === 'POST' && /^\/h\/([^/?#]{1,200})\/([A-Za-z]{1,40})$/.exec(request.url);
  try { return match ? { terminalId: decodeURIComponent(match[1]), event: match[2] } : null; } catch { return null; }
}

// Claude Code's HTTP hooks reach main here, on 127.0.0.1 only: no proxy exemption names another loopback address (K0b
// item 5). The CLI waits for each answer, so it is written before `ingest` sees the event, and nothing ingest does can
// hold a turn. A refused request is answered 404; an event over the size limit is still answered and taken, without
// its payload; an aborted one is counted.
async function createHookServer(ingest, { limit = BODY_LIMIT } = {}) {
  const server = http.createServer((request, response) => {
    const target = targetOf(request), admitted = ingest.admit(target?.terminalId ?? null, request.headers['x-agentrix-key']);
    const chunks = [];
    let size = 0;
    request.on('data', chunk => { size += chunk.length; if (admitted && size <= limit) chunks.push(chunk); });
    request.on('error', () => {});
    // A request the CLI gave up on before its body ended is counted, never taken.
    request.on('close', () => { if (!request.complete) ingest.abort(); });
    request.on('end', () => {
      response.writeHead(admitted ? 200 : 404, { 'content-type': 'application/json' });
      response.end(hookResponse(target?.event, admitted ? ingest.note?.(target.terminalId, target.event) : null), () => {
        if (admitted) ingest.take(target.terminalId, target.event, size > limit ? null : Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let closing;
  return { port: server.address().port, close() {
    return closing ||= new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  } };
}

module.exports = { createHookServer, BODY_LIMIT };
