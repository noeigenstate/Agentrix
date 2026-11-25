const http = require('node:http');
const url = new URL(process.env.AGENTRIX_ASKPASS_URL);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') process.exit(1);
const body = JSON.stringify({ connectionId: process.env.AGENTRIX_ASKPASS_ID, prompt: process.argv.slice(2).join(' '), hint: process.env.SSH_ASKPASS_PROMPT });
const request = http.request(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.AGENTRIX_ASKPASS_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
  let data = '';
  let bytes = 0;
  response.setEncoding('utf8');
  response.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65536) { process.exitCode = 1; response.destroy(); }
    else data += chunk;
  });
  response.on('aborted', () => { process.exitCode = 1; });
  response.on('end', () => {
    try {
      const result = JSON.parse(data);
      if (response.statusCode !== 200 || result.canceled || typeof result.response !== 'string') process.exitCode = 1;
      else process.stdout.write(result.response + '\n');
    }
    catch { process.exitCode = 1; }
  });
});
request.on('error', () => { process.exitCode = 1; });
request.setTimeout(300000, () => request.destroy());
request.end(body);
