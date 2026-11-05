const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.FAKE_RESET_MODE || 'ready', file = process.env.FAKE_RESET_STATE;
const state = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { keys: [], uses: 0 }; } };
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line), { method, id } = request;
  fs.appendFileSync(process.env.FAKE_RESET_WIRE, JSON.stringify(request) + '\n');
  if (method === 'initialize') return send(id, { userAgent: 'codex/0.166.0' });
  if (method === 'initialized') return;
  if (method === 'account/read') { if (mode === 'hang') return; return send(id, { account: mode === 'signed-out' ? null : { type: mode === 'api' ? 'apiKey' : 'chatgpt' } }); }
  if (method === 'account/rateLimits/read') {
    const current = state(), blocked = !current.uses || mode === 'still-limited';
    const at = Math.floor(Date.now() / 1000);
    return send(id, { accountId: 'offline-shared-account', ordinaryUsageAllowed: mode === 'allowed' ? true : !blocked,
      rateLimits: { primary: { usedPercent: blocked ? 100 : 0, windowDurationMins: 300, resetsAt: at + 3600 },
        rateLimitReachedType: blocked ? 'rate_limit_reached' : null },
      rateLimitResetCredits: { availableCount: mode === 'unknown' ? null : mode === 'empty' ? 0 : 2 - current.uses,
        credits: mode === 'count-only' ? null : [
          { id: 'later', status: 'available', expiresAt: at + 10000 }, { id: 'soon', status: 'available', expiresAt: at + 1000 },
          { id: 'expired', status: 'available', expiresAt: at - 1000 },
        ] } });
  }
  if (method === 'account/rateLimitResetCredit/consume') {
    if (mode === 'error') return process.stdout.write(JSON.stringify({ id, error: { code: -32000, message: 'offline consume failed' } }) + '\n');
    const current = state(), key = request.params.idempotencyKey;
    const outcome = current.keys.includes(key) ? 'alreadyRedeemed' : mode === 'declined' ? 'noCredit' : 'reset';
    if (outcome === 'reset') { current.keys.push(key); current.uses++; fs.writeFileSync(file, JSON.stringify(current)); }
    await new Promise(resolve => setTimeout(resolve, 60));
    return send(id, { outcome });
  }
  process.stdout.write(JSON.stringify({ id, error: { code: -32601, message: 'unsupported fake method' } }) + '\n');
});
