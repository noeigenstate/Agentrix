const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { findClaudeSession, encodeClaudeCwd } = require('../../claude-sessions.cjs');
const { containedFile } = require('../../session-files.cjs');

async function sessionHistory(sdk, spec, id) {
  const history = await sdk.getSessionMessages?.(id, { dir: spec.cwd });
  if (!sdk.getSessionMessages) return history;
  const env = spec.env || process.env;
  const userHome = process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME;
  const home = env.CLAUDE_CONFIG_DIR || path.join(userHome || os.homedir(), '.claude');
  const filename = await findClaudeSession(spec.cwd, id, home, { strict: true });
  if (!filename) return history;
  const canonical = await fs.promises.realpath(spec.cwd).catch(() => spec.cwd);
  const canonicalFile = path.join(home, 'projects', encodeClaudeCwd(canonical), `${id}.jsonl`);
  if (history?.length && path.relative(filename, canonicalFile) === '') return history;
  // SDK 0.3.317 canonicalizes dir while its CLI may persist an alias slug. Feed
  // the verified local transcript to the SDK's own chain/compaction decoder.
  // This store is read-only and used only for history, never for a live query.
  return sdk.getSessionMessages(id, { dir: spec.cwd, sessionStore: {
    async load(key) {
      if (key.sessionId !== id || key.subpath) return null;
      const file = await fs.promises.open(filename, 'r'), entries = [];
      let input, lines;
      try {
        if (!await containedFile(path.join(home, 'projects'), filename, { file, exact: true })) return null;
        const { size } = await file.stat();
        if (!size) return null;
        input = file.createReadStream({ encoding: 'utf8', autoClose: false, end: size - 1 });
        lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
          try { entries.push(JSON.parse(line)); } catch { /* Match the SDK's partial/malformed-line handling. */ }
        }
        return await containedFile(path.join(home, 'projects'), filename, { file, exact: true }) ? entries : null;
      } finally { lines?.close(); input?.destroy(); await file.close(); }
    },
  } });
}
module.exports = { sessionHistory };
