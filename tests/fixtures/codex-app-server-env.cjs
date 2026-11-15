// Stand-in contract (tests/fake-cli-contract.test.cjs): --version answers at once and writes nothing; AGENTRIX_STAND_IN_ECHO names the file that gets the arguments, --settings and hooks it was given.
if (process.env.AGENTRIX_STAND_IN_ECHO) require('./stand-in-echo.cjs')();
if (process.argv.includes('--version')) { console.log('2.1.317 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const session = process.env.SYNTHETIC_SESSION || 'synthetic-cli-session';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'synthetic-model', effort: 'high', fast_mode: false }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, result: process.env.SYNTHETIC_ECHO_INPUT ? input : 'Synthetic subscription result', usage: {}, total_cost_usd: 0 }) + '\n');
});
