import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const quote = value => "'" + value.replaceAll("'", "''") + "'";

// One of Claude Code's hooks, as a PowerShell command for an Agentrix terminal: the real hook script with the hook's
// JSON on its input, which is how Claude Code runs it.
export const claudeHook = (kind, payload) => `${quote(JSON.stringify(payload))} | & $global:AgentrixSession.powershellPath -NoProfile -ExecutionPolicy Bypass -File $global:AgentrixSession.claudeHookPath -PipeName $global:AgentrixSession.pipeName -ProjectId $global:AgentrixSession.projectId -SessionKey $global:AgentrixSession.sessionKey -Kind ${kind}`;

// A terminal's own session file (its pipe, its key and the hook script), from the profile's runtime folder.
export async function terminalBootstrap(dataDir, sessionId) {
  const runtime = (await fs.readdir(dataDir)).find(name => name.startsWith('runtime-'));
  return JSON.parse(await fs.readFile(path.join(dataDir, runtime, `${sessionId}.json`), 'utf8'));
}

// The same hook from outside the terminal, for an agent that occupies its shell: the real hook script as a process of
// its own, as Claude Code starts it.
export function sendClaudeHook(bootstrap, kind, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(bootstrap.powershellPath, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bootstrap.claudeHookPath,
      '-PipeName', bootstrap.pipeName, '-ProjectId', bootstrap.projectId, '-SessionKey', bootstrap.sessionKey, '-Kind', kind], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject); child.once('exit', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}

// One round of an agent in a terminal, without the agent's CLI or a model. Claude Code is the agent a terminal runs
// (Codex opens in native mode): the shell reports it as the wrapper does and stays occupied, the real hook script
// reports the submitted prompt and the Stop, and the round's records are read from a transcript in this run's Claude
// home. After the round the Stop repeats and an idle notification arrives, as they do while Claude Code waits at its
// prompt: neither is new work, so neither may complete the round again. Then the agent exits to the shell.
export async function runDesktopTask(page, project, claudeHome, turn, waitFor) {
  const session = randomUUID(), folder = path.join(claudeHome, 'projects', 'desktop-task');
  const file = suffix => path.join(folder, session + suffix);
  const transcript = file('.jsonl'), prompt = `Run desktop test task ${turn}.`, hook = { session_id: session, transcript_path: transcript };
  const row = record => JSON.stringify({ timestamp: new Date().toISOString(), sessionId: session, cwd: project.path, ...record }) + '\n';
  const until = suffix => `for ($pgIndex = 0; $pgIndex -lt 400 -and -not (Test-Path -LiteralPath ${quote(file(suffix))}); $pgIndex++) { Start-Sleep -Milliseconds 50 }`;
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(transcript, row({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: prompt } }));
  await fs.writeFile(file('.ps1'), '﻿' + [
    "Send-AgentrixEvent 'codex-started' -Agent 'claude'",
    // A fresh round includes received input; lifecycle callbacks alone must never arm completion.
    claudeHook('start', { ...hook, prompt }),
    until('.replied'), claudeHook('stop', hook),
    until('.idle'), claudeHook('stop', hook), claudeHook('notify', { ...hook, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
    `Set-Content -LiteralPath ${quote(file('.quiet'))} -Value 'sent'`,
    until('.done'), "Send-AgentrixEvent 'codex-exited' -Agent 'claude'",
  ].join('\r\n') + '\r\n');
  const state = async () => (await page.evaluate(() => window.agentrix.getState())).value.projects.find(item => item.id === project.id);
  const previous = (await state()).lastCompletedAt;
  await page.evaluate(({ id, command }) => window.agentrix.writeTerminal(id, command), { id: project.id, command: `& ${quote(file('.ps1'))}\r` });
  try {
    await waitFor(async () => { const now = await state(); return now.codexActive && now.agent === 'claude' && now.codexActivity === 'working'; }, 'offline task starts with its prompt');
    await fs.appendFile(transcript, row({ type: 'assistant', uuid: randomUUID(), message: { role: 'assistant', content: [{ type: 'text', text: `Finished ${turn}.` }], stop_reason: 'end_turn' } }));
    await fs.writeFile(file('.replied'), '');
    await waitFor(async () => (await state()).lastCompletedAt !== previous, 'interactive parent task completion');
    const completed = await state();
    await fs.writeFile(file('.idle'), '');
    await waitFor(() => fs.access(file('.quiet')).then(() => true, () => false), 'the repeated Stop and the idle notification are sent');
    await new Promise(resolve => setTimeout(resolve, 300));
    const quiet = await state();
    assert.deepEqual([quiet.lastCompletedAt, quiet.unread, quiet.codexActivity], [completed.lastCompletedAt, completed.unread, 'complete'],
      'a repeated Stop and an idle notification never complete the round again');
  } finally { await fs.writeFile(file('.done'), ''); }
  await waitFor(async () => (await state()).shellReady, 'offline task returns to shell');
}
