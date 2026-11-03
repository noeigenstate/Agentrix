let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const session = process.env.SYNTHETIC_SESSION || 'synthetic-cli-session';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'synthetic-model', effort: 'high', fast_mode: false }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, result: process.env.SYNTHETIC_ECHO_INPUT ? input : 'Synthetic subscription result', usage: {}, total_cost_usd: 0 }) + '\n');
});
