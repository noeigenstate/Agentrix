import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function createFixture(root, directory, mib) {
  const project = { id: randomUUID(), name: 'Open latency', path: path.join(directory, 'project'), kind: 'local' };
  const bin = path.join(directory, 'bin'), codexHome = path.join(directory, 'codex'), claudeHome = path.join(directory, 'claude');
  for (const folder of [project.path, bin, path.join(codexHome, 'sessions'), path.join(claudeHome, 'projects')]) await fs.mkdir(folder, { recursive: true });
  await Promise.all(Array.from({ length: 150 }, (_, n) => fs.writeFile(path.join(project.path, `file-${n}.txt`), `synthetic ${n}\n`)));
  await fs.writeFile(path.join(project.path, 'output.md'), '# Synthetic document\n\nOffline fixture.\n');
  await exec('git', ['init', '--quiet', project.path], { windowsHide: true });
  let code = await fs.readFile(path.join(root, 'tests/fixtures/restore-codex.cs'), 'utf8');
  code = code.replace('Console.OutputEncoding = new UTF8Encoding(false);', `Console.OutputEncoding = new UTF8Encoding(false);
        var startupClock = System.Diagnostics.Stopwatch.StartNew();
        int resume = Array.IndexOf(args, "resume");
        if (resume < 0) resume = Array.IndexOf(args, "--resume");
        if (resume >= 0 && resume + 1 < args.Length) Console.Title = args[resume + 1];`);
  code = code.replace('Console.WriteLine("RESTORE_FIXTURE_READY");', `Console.WriteLine("RESTORE_FIXTURE_READY");
        if (System.Diagnostics.Process.GetCurrentProcess().ProcessName == "claude") {
            Console.WriteLine("────────────────────"); Console.WriteLine("❯ "); Console.WriteLine("────────────────────");
        } else { Console.WriteLine("› Ask Codex to do anything"); Console.WriteLine("gpt-6.1-sol · high · 100% context left"); }
        File.WriteAllText(Path.Combine(Directory.GetCurrentDirectory(), "cli-latency.json"), new JavaScriptSerializer().Serialize(new {
            mainToInputMs = startupClock.Elapsed.TotalMilliseconds,
            readyAt = (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000.0
        }));`);
  const source = path.join(directory, 'fake.cs'); await fs.writeFile(source, code);
  await exec(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${path.join(bin, 'codex.exe')}`, source], { windowsHide: true });
  await fs.copyFile(path.join(bin, 'codex.exe'), path.join(bin, 'claude.exe'));
  const transcripts = {};
  const text = ('Generated **Markdown**, `code`, and an ordinary paragraph.\n\n').repeat(100);
  const output = 'Synthetic tool output without credentials.\n'.repeat(700);
  for (const agent of ['codex', 'claude']) {
    const threadId = randomUUID(), marker = `OPEN_LATENCY_LATEST_${agent}_${mib}`;
    const folder = agent === 'codex' ? path.join(codexHome, 'sessions') : path.join(claudeHome, 'projects', project.path.replace(/[^A-Za-z0-9]/gu, '-'));
    await fs.mkdir(folder, { recursive: true });
    const filename = path.join(folder, agent === 'codex' ? `rollout-${threadId}.jsonl` : `${threadId}.jsonl`);
    const file = await fs.open(filename, 'w'); let bytes = 0, turns = 0;
    const append = async record => { const line = JSON.stringify(record) + '\n'; bytes += Buffer.byteLength(line); await file.write(line); };
    if (agent === 'codex') await append({ type: 'session_meta', payload: { id: threadId, cwd: project.path, source: 'cli', model_provider: 'openai' } });
    do {
      const n = turns++, timestamp = new Date(Date.now() - 86400000 + n * 1000).toISOString(), latest = bytes >= mib * 1024 * 1024;
      const answer = text + `\n${latest ? marker : 'Answer ' + n}\n`;
      if (agent === 'codex') {
        await append({ type: 'event_msg', timestamp, payload: { type: 'task_started', turn_id: `t${n}` } });
        await append({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: `Question ${n}` } });
        await append({ type: 'response_item', timestamp, payload: { type: 'function_call', name: 'exec_command', call_id: `c${n}`, arguments: '{"cmd":"echo synthetic"}' } });
        await append({ type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: `c${n}`, output } });
        await append({ type: 'event_msg', timestamp, payload: { type: 'agent_message', message: answer } });
        await append({ type: 'event_msg', timestamp, payload: { type: 'task_complete', turn_id: `t${n}` } });
      } else {
        await append({ type: 'user', uuid: `u${n}`, sessionId: threadId, timestamp, message: { content: `Question ${n}` } });
        await append({ type: 'assistant', uuid: `tool${n}`, sessionId: threadId, timestamp, message: { content: [{ type: 'tool_use', id: `c${n}`, name: 'Bash', input: { command: 'echo synthetic' } }] } });
        await append({ type: 'user', uuid: `out${n}`, sessionId: threadId, timestamp, message: { content: [{ type: 'tool_result', tool_use_id: `c${n}`, content: output }] } });
        await append({ type: 'assistant', uuid: `a${n}`, sessionId: threadId, timestamp, message: { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] } });
      }
      if (latest) break;
    } while (true);
    await file.close(); transcripts[agent] = { threadId, filename, bytes, turns, marker };
  }
  return { project, bin, codexHome, claudeHome, transcripts };
}

// Explicit allowlist: a fresh HOME and three profile directories are insufficient if provider tokens are inherited.
export function isolatedEnvironment(fixture, profile, home) {
  const allowed = /^(?:SystemRoot|windir|COMSPEC|PATHEXT|ProgramFiles(?:\(x86\))?|ProgramData|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i;
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key))),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
    TEMP: home, TMP: home, AGENTRIX_DATA_DIR: profile, CODEX_HOME: fixture.codexHome, CLAUDE_CONFIG_DIR: fixture.claudeHome,
    // An explicit endpoint blocks Codex's upward search for a .codex/config.toml outside the isolated home.
    AGENTRIX_TEST_RESTORE: '1', OPENAI_BASE_URL: 'http://127.0.0.1:9/offline-probe',
    Path: [fixture.bin, path.dirname(process.execPath), path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0'), 'C:\\Program Files\\Git\\cmd'].join(path.delimiter) };
}
