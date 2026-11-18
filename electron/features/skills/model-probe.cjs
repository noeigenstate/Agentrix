// Catalog probes never start a thread or submit input. All process/SDK access is injected by main.
async function probeCodex({ spawn, executable, rpcFactory, stop, workerEnvironment, cwd, env, timers = globalThis, timeoutMs = 10000 }) {
  let child, rpc, timer, stopped = false;
  try {
    return await Promise.race([(async () => {
      const file = await executable();
      if (stopped) throw new Error('model_probe_timeout');
      child = spawn(file, ['app-server', '--listen', 'stdio://'], { cwd, env: workerEnvironment(env), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      rpc = rpcFactory(child);
      await rpc.request('initialize', { clientInfo: { name: 'agentrix-models', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      const rows = [], cursors = new Set(); let cursor = null;
      do {
        const page = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false });
        rows.push(...(page.data || []).slice(0, 300 - rows.length));
        cursor = page.nextCursor;
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
      } while (cursor && rows.length < 300 && cursors.size < 10);
      return rows;
    })(), new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new Error('model_probe_timeout')), timeoutMs); })]);
  } finally {
    stopped = true; timers.clearTimeout(timer); rpc?.close();
    try { if (child) await stop(child); }
    finally { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); }
  }
}

async function probeClaude({ loadSdk, options = {}, timers = globalThis, timeoutMs = 10000 }) {
  const abort = new AbortController(); let query, timer, wake, stopped = false;
  const prompt = { async *[Symbol.asyncIterator]() { if (!stopped) await new Promise(resolve => { wake = resolve; }); } };
  try {
    return await Promise.race([(async () => {
      const sdk = await loadSdk();
      if (abort.signal.aborted) throw new Error('model_probe_timeout');
      query = sdk.query({ prompt, options: { ...options, settingSources: [], persistSession: false, abortController: abort } });
      return await query.supportedModels();
    })(), new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new Error('model_probe_timeout')), timeoutMs); })]);
  } finally {
    timers.clearTimeout(timer); stopped = true; wake?.();
    abort.abort();
    try { Promise.resolve(query?.interrupt()).catch(() => {}); } finally { query?.close?.(); }
  }
}

module.exports = { probeCodex, probeClaude };
