// A command hook for the real-CLI hook tests (tests/fixtures/claude-hooks-real.cjs): it hands the hook's JSON to the hook
// receiver over a direct HTTP request, as Agentrix's own command hook hands it to main, and prints nothing, so the CLI's model
// context cannot change. Usage: claude-hook-recorder.cjs <EventName> <hook url> <key>
const http = require('node:http');
const [event, url, key] = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = http.request(`${url}/${event}`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'x-agentrix-key': key } }, response => { response.resume(); response.on('end', () => process.exit(0)); });
  request.on('error', () => process.exit(0));
  request.end(input);
});
