// Local tool shells reach these shims through PATH; interactive owner shells keep their own CLI functions first.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const SHIM_NAMES = ['.agentrix-shims', 'codex', 'codex.cmd', 'codex.ps1', 'claude', 'claude.cmd', 'claude.ps1'];
const LIMIT = 4 * 1024 * 1024;

function shimFiles() {
  // The SSH carrier accepts CJS modules only. Its launcher envelope is the same files, never a second implementation.
  if (!fs.existsSync(path.join(__dirname, 'codex'))) return require('./launchers.cjs');
  return Object.fromEntries(SHIM_NAMES.map(name => [name, fs.readFileSync(path.join(__dirname, name), 'utf8')]));
}

function runtimeFiles() {
  return { 'shims/intercept.cjs': fs.readFileSync(__filename, 'utf8'),
    'shims/launchers.cjs': `module.exports = ${JSON.stringify(shimFiles())};\n` };
}

function withShims(source, { depth, runId, proof }) {
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error('Invalid dispatch depth');
  const env = { ...source }, key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const inherited = env[key] || '';
  for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH' || /^AGENTRIX_(?:DISPATCH_DEPTH|RUN_ID|RUN_PROOF|SHIM_NODE)$/i.test(name)) delete env[name];
  // SSH shims are deferred: a carried module without an installed marker never changes a remote worker's PATH.
  const installed = fs.existsSync(path.join(__dirname, '.agentrix-shims'));
  const same = folder => process.platform === 'win32' ? path.resolve(folder.replace(/^"|"$/g, '')).toLowerCase() === __dirname.toLowerCase() : folder === __dirname;
  env[key] = installed ? [__dirname, ...inherited.split(path.delimiter).filter(folder => !same(folder))].join(path.delimiter) : inherited;
  env.AGENTRIX_DISPATCH_DEPTH = String(depth);
  env.AGENTRIX_SHIM_NODE = process.execPath;
  if (depth > 0) { env.AGENTRIX_RUN_ID = runId; env.AGENTRIX_RUN_PROOF = proof; }
  return env;
}

function unsupported(option) { return Object.assign(new Error(option), { option }); }

// Only the documented CLI subset has a dispatcher equivalent. Everything else is refused before admission.
function mapCommand(agent, argv, cwd = process.cwd()) {
  if (!['codex', 'claude'].includes(agent)) throw unsupported(String(agent));
  const options = { agent, model: agent === 'codex' ? 'gpt-6.1-sol' : 'sonnet', effort: 'high', fast: false,
    permission: 'acceptEdits', readOnly: false, images: [], cwd, out: null, prompt: null };
  const seen = new Set(), positional = [];
  let print = false, literal = false, refusal = null, refusalCount = 0;
  const refuse = option => { refusal ||= option; refusalCount++; };
  const once = (key, option) => { if (seen.has(key)) { refuse(option); return false; } seen.add(key); return true; };
  const args = [...argv];
  if (agent === 'codex' && args.shift() !== 'exec') throw unsupported(argv[0] || 'codex (interactive)');
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (literal || token === '-' || !token.startsWith('-')) { positional.push(token); continue; }
    if (token === '--') { literal = true; continue; }
    const equal = token.indexOf('='), flag = equal > 0 ? token.slice(0, equal) : token;
    const value = () => {
      const text = equal > 0 ? token.slice(equal + 1) : args[++index];
      if (typeof text !== 'string' || !text || text.startsWith('--') || text.includes('\0')) { refuse(flag); return null; }
      return text;
    };
    if (agent === 'claude' && ['-p', '--print'].includes(flag)) { if (equal > 0 || !once('print', '--print')) refuse(flag); print = true; continue; }
    if (['-m', '--model'].includes(flag) && (agent === 'codex' || flag === '--model')) {
      const text = value(); if (once('model', '--model') && text) options.model = text; continue;
    }
    if (agent === 'claude' && flag === '--effort') { const text = value(); if (once('effort', flag) && text) options.effort = text; continue; }
    if (agent === 'claude' && flag === '--permission-mode') {
      const text = value(); if (!once('permission', flag) || text !== 'acceptEdits') refuse(flag); continue;
    }
    if (agent === 'claude' && flag === '--output-format') {
      if (!once('format', flag) || value() !== 'text') refuse(flag); continue;
    }
    if (agent === 'codex' && flag === '-c') {
      const text = value(), match = text && /^\s*(model_reasoning_effort|service_tier)\s*=\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([a-zA-Z0-9_-]+))\s*$/.exec(text);
      if (!match || !once(match[1], flag)) { refuse(flag); continue; }
      const setting = match[2] ?? match[3] ?? match[4];
      if (match[1] === 'model_reasoning_effort') options.effort = setting;
      else if (setting === 'fast') options.fast = true;
      else refuse(flag);
      continue;
    }
    if (agent === 'codex' && ['-C', '--cd', '-o', '--output-last-message', '--image', '--sandbox'].includes(flag)) {
      const text = value(); if (text === null) continue;
      if (flag === '--image') options.images.push(text);
      else if (['-C', '--cd'].includes(flag)) { if (once('cwd', '--cd')) options.cwd = path.resolve(cwd, text); }
      else if (flag === '--sandbox') { if (!once('sandbox', flag) || text !== 'read-only') refuse(flag); else options.readOnly = true; }
      else if (once('out', '-o')) options.out = text;
      continue;
    }
    refuse(flag);
  }
  if (agent === 'claude' && !print) refuse('claude (interactive)');
  if (positional.length > 1 || positional.some(text => text.includes('\0'))) refuse('prompt');
  if (/[\0\r\n]/.test(options.model) || options.model.length > 160) refuse('--model');
  if (!/^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/.test(options.effort)) refuse(agent === 'codex' ? '-c model_reasoning_effort' : '--effort');
  options.prompt = positional[0] === '-' ? null : positional[0] ?? null;
  options.cwd = path.resolve(options.cwd);
  if (options.out) options.out = path.resolve(options.cwd, options.out);
  options.images = options.images.map(file => path.resolve(options.cwd, file));
  if (refusal) throw Object.assign(unsupported(refusal), { mapped: refusalCount === 1 ? options : undefined });
  return options;
}

function helperPath() {
  // Local source/packaged shims are beside dispatch.cjs; a carried shim module is under electron/shims.
  return path.resolve(__dirname, fs.existsSync(path.join(__dirname, '../dispatch.cjs')) ? '../dispatch.cjs' : '../../dispatch.cjs');
}

function helperArguments(options, brief, out) {
  return [options.agent, '--role', 'exec', '--title', `Intercepted ${options.agent} call`, '--model', options.model, '--effort', options.effort,
    '--cwd', options.cwd, '--brief', brief, '--out', out,
    ...(options.agent === 'claude' ? ['--permission', options.permission] : [
      ...(options.fast ? ['--fast'] : []), ...(options.readOnly ? ['--read-only'] : []), ...options.images.flatMap(file => ['--image', file]),
    ])];
}

async function stdinText() {
  if (process.stdin.isTTY) return '';
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += Buffer.byteLength(chunk); if (size > LIMIT) throw new Error('stdin exceeds 4 MiB'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString('utf8');
}

async function intercept(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, readInput = stdinText, dispatch } = {}) {
  const [agent, ...rest] = argv, args = rest[0] === '--' ? rest.slice(1) : rest;
  const depth = env.AGENTRIX_DISPATCH_DEPTH ?? '0';
  if (!/^0$/.test(String(depth))) {
    stderr.write(`[dispatch] not run: dispatch.intercept_nested\n[dispatch] request: node ${JSON.stringify(helperPath())} delegate ${agent === 'claude' ? 'claude' : 'codex'} --title <one-line> --model <model> --brief <file> --out <file>\n`);
    return 2;
  }
  let options;
  try { options = mapCommand(agent, args, cwd); }
  catch (error) {
    const option = String(error.option || 'arguments').replace(/[\r\n\0]/g, ' ').slice(0, 160);
    stderr.write(`[dispatch] not run: ${option} is not supported through the Agentrix dispatcher\n`);
    if (error.mapped) stderr.write(`[dispatch] equivalent: node ${JSON.stringify(helperPath())} ${helperArguments(error.mapped, '<brief.md>', '<answer.md>').map(word => JSON.stringify(word)).join(' ')}\n`);
    return 2;
  }
  let directory;
  try {
    const prompt = options.prompt ?? await readInput();
    if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > LIMIT || !prompt.trim()) throw new Error('a non-empty prompt of at most 4 MiB is required');
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrix-intercept-'));
    const brief = path.join(directory, 'brief.md'), out = path.join(directory, 'answer.md');
    fs.writeFileSync(brief, prompt, { mode: 0o600 });
    const run = dispatch || require(helperPath()).run;
    const code = await run(helperArguments(options, brief, out), { env, stdout: stderr, source: 'intercepted' });
    if (fs.existsSync(out)) {
      const answer = fs.readFileSync(out);
      if (options.out) fs.writeFileSync(options.out, answer);
      stdout.write(answer);
    } else if (code === 0) throw new Error('intercept_result_missing');
    return code === 0 ? 0 : 1;
  } catch (error) {
    // No stack, argv or environment on the reporting channel: a provider or filesystem error may carry credentials.
    const code = typeof error.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(error.code) ? error.code : 'intercept_failed';
    stderr.write(`[dispatch] not run: ${code}\n`); return 1;
  } finally {
    if (directory) try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    catch { stderr.write('[dispatch] intercept cleanup failed\n'); return 1; }
  }
}

if (require.main === module) {
  let argv = process.argv.slice(2);
  if (!argv.length && process.env.AGENTRIX_INTERCEPT_ARGV) {
    try { argv = JSON.parse(process.env.AGENTRIX_INTERCEPT_ARGV); } catch { argv = []; }
  }
  delete process.env.AGENTRIX_INTERCEPT_ARGV;
  intercept(Array.isArray(argv) && argv.every(word => typeof word === 'string') ? argv : []).then(code => { process.exitCode = code; });
}
module.exports = { mapCommand, intercept, withShims, shimFiles, runtimeFiles };
