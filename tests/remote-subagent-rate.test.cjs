const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AgentCalls } = require('../electron/features/agents/agent-calls.cjs');
const { findPython } = require('../scripts/python-command.cjs');

const worker = path.join(__dirname, '../integration/remote-worker.py');
const agentId = 'a0123456789abcdef';
let interpreter;
// Run the real collector against private temporary transcripts. On Windows only the descriptor-relative opens are
// adapted, as in remote_worker_test.py; Linux and macOS exercise the actual no-follow opens and symbolic links.
const python = String.raw`
import contextlib, errno, json, os, sys, tempfile, threading, types
from pathlib import Path
from unittest import mock

payload = json.load(sys.stdin)
remote = types.ModuleType("remote_worker")
remote.__file__ = payload["filename"]
exec(compile(payload["source"], remote.__file__, "exec"), remote.__dict__)
agent_id = "a0123456789abcdef"
rows = payload["records"].splitlines(True)

@contextlib.contextmanager
def session():
    with tempfile.TemporaryDirectory(prefix="agentrix-ssh-rate-") as temporary:
        home = Path(temporary)
        transcript = home / "projects" / "project" / "session.jsonl"
        folder = transcript.parent / "session" / "subagents"
        folder.mkdir(parents=True)
        transcript.write_text(json.dumps({"type": "user", "uuid": "parent", "message": {"content": "Task"}}) + "\n", encoding="utf-8")
        child = folder / ("agent-%s.jsonl" % agent_id)
        child.write_text("".join(rows[:3]), encoding="utf-8")
        worker = remote.Worker.__new__(remote.Worker)
        worker.claude_home, worker.claude_reader = str(home), None
        worker.activity_lock = threading.Lock()
        with contextlib.ExitStack() as stack:
            if os.name == "nt":
                stack.enter_context(mock.patch.object(remote, "subagent_folder", lambda _path: os.open(str(transcript), os.O_RDONLY)))
                stack.enter_context(mock.patch.object(remote, "open_regular", lambda name, _folder: (folder / name).open("rb")))
            worker.claude_status(str(transcript), 1000, [agent_id])
            def poll(): return worker.claude_status(str(transcript), 1000, [agent_id]).get("subagents", {})
            yield home, child, poll

def recovery(fault):
    with session() as (home, child, poll):
        answers = [poll()]
        open_regular = remote.open_regular
        if fault in ("missing", "symlink"):
            saved = child.with_suffix(".saved")
            child.rename(saved)
            with contextlib.ExitStack() as stack:
                if fault == "symlink":
                    outside = home / "outside.jsonl"
                    outside.write_text('PRIVATE OUTSIDE RECORD\n', encoding="utf-8")
                    if os.name == "posix": child.symlink_to(outside)
                    else: stack.enter_context(mock.patch.object(remote, "open_regular", side_effect=OSError(errno.ELOOP, "link")))
                answers.append(poll())
            if child.is_symlink(): child.unlink()
            saved.rename(child)
            with child.open("a", encoding="utf-8") as output: output.write("".join(rows[3:]))
        else:
            with child.open("a", encoding="utf-8") as output: output.write("".join(rows[3:]))
            error = OSError(errno.EMFILE, "too many open files")
            @contextlib.contextmanager
            def unreadable(name, folder):
                with open_regular(name, folder) as source:
                    proxy = mock.Mock(wraps=source)
                    proxy.read.side_effect = error
                    yield proxy
            target, failure = ("subagent_folder", {"side_effect": error}) if fault == "folder" else (
                "open_regular", {"side_effect": error} if fault == "open" else {"side_effect": unreadable})
            with mock.patch.object(remote, target, **failure): answers.append(poll())
        answers.extend([poll(), poll()])
        return answers

if sys.argv[1] == "recovery":
    answer = [recovery(fault) for fault in ("missing", "symlink")]
elif sys.argv[1] == "emfile":
    answer = [recovery(fault) for fault in ("open", "read", "folder")]
else:
    with session() as (home, child, poll):
        answer = [poll()]
        metadata = child.with_suffix(".meta.json")
        metadata.write_text(json.dumps({"toolUseId": "toolu_foreground", "private": "PRIVATE METADATA"}), encoding="utf-8")
        answer.append(poll())
        for value in (None, [], {}, {"toolUseId": True}, {"toolUseId": ""}, {"toolUseId": "x" * 1000}):
            metadata.write_text(json.dumps(value), encoding="utf-8")
            answer.append(poll())
        for body in ("{", " " * (64 * 1024) + '{"toolUseId":"toolu_too_large"}'):
            metadata.write_text(body, encoding="utf-8")
            answer.append(poll())
        if os.name == "posix":
            outside = home / "outside.meta.json"
            outside.write_text('{"toolUseId":"toolu_outside"}', encoding="utf-8")
            metadata.unlink(); metadata.symlink_to(outside)
            answer.append(poll())
print(json.dumps(answer))
`;

function collect(scenario) {
  interpreter ||= findPython();
  const result = spawnSync(interpreter.command, [...interpreter.args, '-I', '-B', '-c', python, scenario], {
    input: JSON.stringify({ filename: worker, source: fs.readFileSync(worker, 'utf8'),
      records: fs.readFileSync(path.join(__dirname, 'fixtures/claude-subagent-ssh.jsonl'), 'utf8') }),
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function recoveredRate(t, answers) {
  const calls = new AgentCalls({ local: false, since: 0 });
  t.after(() => calls.dispose());
  calls.apply({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { model: 'claude-opus-5-5',
    content: [{ type: 'tool_use', id: 'toolu_launch', name: 'Agent', input: { model: 'opus', run_in_background: true } }] } });
  calls.apply({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', toolUseResult: { isAsync: true, agentId },
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_launch', content: 'Running' }] } });
  calls.remoteRecords(answers[0]);
  const rate = () => calls.calls.get('toolu_launch').rate;
  assert.equal(rate().outputTokens, 45);
  assert.equal(rate().partial, false);
  calls.remoteRecords(answers[1]);
  assert.equal(rate().partial, true, 'the unreadable file is partial during the failed poll');
  calls.remoteRecords(answers[2]);
  assert.deepEqual([rate().outputTokens, rate().activeMs, rate().samples, rate().partial], [75, 5000, 2, false],
    'the same file recovers its full rate without duplicate samples or a persistent partial label');
  const complete = { ...rate() };
  calls.remoteRecords(answers[3]);
  assert.deepEqual(rate(), complete, 'later polls resume incrementally');
}

test('a sub-agent file that vanishes or becomes a symlink mid-read recovers instead of staying behind', t => {
  for (const answers of collect('recovery')) recoveredRate(t, answers);
});

test('an EMFILE while reading a sub-agent file leaves rates partial only until the next read', t => {
  for (const answers of collect('emfile')) recoveredRate(t, answers);
});

test("a foreground sub-agent's record carries its toolUseId before it ends", () => {
  const answers = collect('metadata');
  assert.equal(answers[1][agentId].toolUseId, 'toolu_foreground', 'metadata can arrive after the first transcript read');
  assert.deepEqual(answers[1][agentId].records, [], 'the identity is available without a completion or another reply');
  for (const entry of [answers[0], ...answers.slice(2)]) {
    assert.equal(Object.hasOwn(entry[agentId], 'toolUseId'), false, 'missing, invalid, oversized or linked metadata gives no identity');
  }
  assert.ok(!JSON.stringify(answers).includes('PRIVATE'), 'metadata contents stay on the host');
});
