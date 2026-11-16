const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { findClaudeSession } = require('../../claude-sessions.cjs');
const { containedFile } = require('../../session-files.cjs');

async function claudeSubagentFolder(spec, sessionId, transcriptPath) {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,100}$/.test(sessionId) || !path.isAbsolute(spec.cwd || '')) return null;
  const env = spec.env || process.env;
  const userHome = process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME;
  const home = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(userHome || os.homedir(), '.claude'));
  let filename;
  if (transcriptPath != null) {
    if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || path.basename(transcriptPath) !== `${sessionId}.jsonl`) return null;
    const projects = path.join(home, 'projects'), directory = path.dirname(transcriptPath), relative = path.relative(projects, directory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    // Bind the SDK's spelling before files arrive; rebinding later would clear live rows. The rate reader checks every opened file again.
    if (!await containedFile(projects, directory, { exact: true, directoryOnly: true })) {
      try { await fs.lstat(directory); return null; }
      catch (error) { if (error.code !== 'ENOENT') return null; }
    }
    filename = transcriptPath;
  } else filename = await findClaudeSession(spec.cwd, sessionId, home, { strict: true });
  return filename ? path.join(path.dirname(filename), sessionId, 'subagents') : null;
}

module.exports = { claudeSubagentFolder };
