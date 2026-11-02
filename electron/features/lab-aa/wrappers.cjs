const path = require('node:path');
const { fs } = require('./cache.cjs');

// Serialized into the workspace: it knows only the per-run broker, never Docker or a source credential.
function brokerClient() {
  const net = require('node:net');
  const fail = () => { process.stderr.write('Lab container command failed.\n'); process.exitCode = 125; };
  let config;
  try {
    config = JSON.parse(process.env.AGENTRIX_LAB_BROKER);
    if (typeof config.address !== 'string' || typeof config.capability !== 'string' || !process.argv[2]) throw new Error();
  } catch { fail(); return; }
  const chunks = []; let inputBytes = 0;
  process.stdin.on('data', chunk => {
    inputBytes += chunk.length;
    if (inputBytes > 128 * 1024) { fail(); process.stdin.destroy(); }
    else chunks.push(chunk);
  });
  process.stdin.on('error', fail);
  process.stdin.on('end', () => {
    if (process.exitCode) return;
    const socket = net.connect(config.address);
    let output = '', completed = false;
    socket.setEncoding('utf8'); socket.setTimeout(121000, () => socket.destroy());
    socket.on('connect', () => socket.write(JSON.stringify({
      capability: config.capability, argv: process.argv.slice(2), stdin: Buffer.concat(chunks).toString('utf8'), timeoutMs: 120000,
    }) + '\n'));
    socket.on('data', chunk => {
      if (completed) return socket.destroy();
      output += chunk;
      if (Buffer.byteLength(output) > 9 * 1024 * 1024) return socket.destroy();
      if (!output.includes('\n')) return;
      try {
        const reply = JSON.parse(output.trim());
        if (!Number.isInteger(reply.code) || reply.code < 0 || reply.code > 255 ||
          typeof reply.stdout !== 'string' || typeof reply.stderr !== 'string') throw new Error();
        completed = true; process.stdout.write(reply.stdout); process.stderr.write(reply.stderr);
        process.exitCode = reply.code; socket.end();
      } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (!completed) fail(); });
  });
  process.stdin.resume();
}

async function installWrappers(cwd, nodePath) {
  const bin = path.join(cwd, 'bin');
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'tb.cjs'), '(' + brokerClient.toString() + ')();\n', { mode: 0o600 });
  const shellNode = "'" + nodePath.replace(/'/g, "'\\''") + "'";
  await fs.writeFile(path.join(bin, 'tb'), '#!/bin/sh\nexec ' + shellNode + ' "$(dirname "$0")/tb.cjs" "$@"\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'tb.cmd'), '@echo off\r\n"' + nodePath.replace(/%/g, '%%') + '" "%~dp0tb.cjs" %*\r\n', { mode: 0o600 });
}

module.exports = { installWrappers };
