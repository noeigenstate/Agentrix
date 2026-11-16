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
import contextlib, errno, io, json, os, sys, tempfile, threading, types
from pathlib import Path
from unittest import mock

payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
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

@contextlib.contextmanager
def synthetic(ids):
    state = types.SimpleNamespace(files={}, versions={}, opens={}, bytes={}, errors={}, read_errors={}, folder_error=None)
    reader = remote.ClaudeTranscriptReader("session.jsonl", 1000)
    descriptors = {}
    class Source(io.BytesIO):
        def __init__(self, name):
            super().__init__(state.files[name])
            self.name = name
        def fileno(self):
            descriptor = len(descriptors) + 1
            descriptors[descriptor] = self.name
            return descriptor
        def read(self, size=-1):
            error = state.read_errors.get(self.name)
            if error and self.tell() >= error[0]: raise OSError(error[1], "read fault")
            chunk = super().read(size)
            state.bytes[self.name] = state.bytes.get(self.name, 0) + len(chunk)
            return chunk
    def folder(_path):
        if state.folder_error is not None: raise OSError(state.folder_error, "folder fault")
        return 900
    def opened(name, _folder):
        state.opens[name] = state.opens.get(name, 0) + 1
        if name in state.errors: raise OSError(state.errors[name], "open fault")
        if name not in state.files: raise FileNotFoundError(errno.ENOENT, "missing")
        return Source(name)
    def info(descriptor):
        name = descriptors[descriptor]
        return types.SimpleNamespace(st_size=len(state.files[name]), st_dev=1, st_ino=state.versions.get(name, 1))
    with mock.patch.object(remote, "subagent_folder", side_effect=folder), mock.patch.object(remote, "open_regular", side_effect=opened), \
         mock.patch.object(remote.os, "fstat", side_effect=info), mock.patch.object(remote.os, "close"):
        yield state, reader, lambda: reader.read_subagents(ids)

def large_transients():
    answers = []
    name = "agent-%s.jsonl" % agent_id
    for code in (errno.EMFILE, errno.ENFILE, errno.ENOMEM, errno.EAGAIN, errno.EINTR):
        for phase in ("folder", "open", "read"):
            with synthetic([agent_id]) as (state, reader, poll):
                state.files[name] = "".join(rows[:3]).encode("utf-8")
                poll()
                state.files[name] += b" " * (remote.HISTORY_WINDOW + 1024) + b"\n" + "".join(rows[3:]).encode("utf-8")
                stream = reader.subagents[agent_id]
                while stream.offset < len(state.files[name]) or stream.outbox: poll()
                late = b'{"type":"user","uuid":"late","message":{"content":"Next task"}}\n'
                state.files[name] += late[:35]
                poll()
                def snapshot(): return {"identity": stream.file_identity, "offset": stream.offset, "buffer": stream.buffer[:128].hex(), "partial": stream.partial}
                before = snapshot()
                state.files[name] += late[35:]
                if phase == "folder": state.folder_error = code
                elif phase == "open": state.errors[name] = code
                else: state.read_errors[name] = (0, code)
                failed = poll().get(agent_id)
                after = snapshot()
                state.folder_error = None; state.errors.clear(); state.read_errors.clear()
                recovered = poll()[agent_id]
                answers.append({"code": code, "phase": phase, "window": remote.HISTORY_WINDOW,
                    "before": before, "after": after, "failed": failed, "recovered": recovered, "end": snapshot()})
    return answers

def byte_budget():
    answers = []
    for partial_read in (False, True):
        bad = ["bad%d" % index for index in range(1 if partial_read else 4)]
        good = ["good%d" % index for index in range(4)]
        with synthetic(bad + good) as (state, reader, poll):
            for identity in bad + good: state.files["agent-%s.jsonl" % identity] = b"x" * (remote.SUBAGENT_READ_LIMIT - 1) + b"\n"
            for identity in bad:
                name = "agent-%s.jsonl" % identity
                if partial_read: state.read_errors[name] = (65536, errno.EMFILE)
                else: state.errors[name] = errno.EMFILE
            poll()
            answers.append({"total": sum(state.bytes.values()), "good": [state.bytes.get("agent-%s.jsonl" % identity, 0) for identity in good]})
    return answers

def metadata_cache():
    with synthetic([agent_id]) as (state, reader, poll):
        name, meta = "agent-%s.jsonl" % agent_id, "agent-%s.meta.json" % agent_id
        state.files[name] = "".join(rows[:3]).encode("utf-8")
        state.files[meta] = b'{"toolUseId":"toolu_original"}'
        answers = []
        def take():
            entry = poll()[agent_id]
            answers.append([entry.get("toolUseId"), state.opens.get(meta, 0), entry["reset"]])
        take(); take()
        state.errors[meta] = errno.EMFILE
        take()
        state.versions[name] = 2
        state.files[meta] = b'{"toolUseId":"toolu_refreshed"}'
        take()
        state.errors.clear()
        take(); take()
        state.versions[name] = 3
        del state.files[meta]
        take()
        state.files[meta] = b'{"toolUseId":"toolu_returned"}'
        take()
        return answers

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

if sys.argv[1] == "large": answer = large_transients()
elif sys.argv[1] == "budget": answer = byte_budget()
elif sys.argv[1] == "cache": answer = metadata_cache()
elif sys.argv[1] == "recovery":
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
            child.write_text("", encoding="utf-8")
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

function recoveredRate(t, answers, transient = false) {
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
  if (transient) {
    assert.equal(answers[1][agentId]?.partial, true, 'only the failed poll is partial');
    assert.equal(answers[1][agentId].reset, false, 'a transient failure retains the meter');
    assert.equal(answers[2][agentId].reset, false, 'recovery resumes rather than replaying history');
  } else assert.equal(rate().partial, true, 'the unreadable file is partial during the failed poll');
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
  for (const answers of collect('emfile')) recoveredRate(t, answers, true);
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

test('transient folder, open and read failures preserve complete history beyond eight MiB and an unfinished record', () => {
  for (const answer of collect('large')) {
    assert.ok(answer.before.offset > answer.window);
    assert.ok(answer.before.buffer.length > 0);
    assert.equal(answer.before.partial, false);
    assert.deepEqual(answer.after, answer.before, `${answer.code}/${answer.phase} preserves identity, offset and buffer`);
    assert.equal(answer.failed?.partial, true);
    assert.equal(answer.failed.reset, false);
    assert.equal(answer.failed.behind, true, 'an unreadable file is not known to be drained');
    assert.equal(answer.recovered.partial, false);
    assert.equal(answer.recovered.reset, false);
    assert.equal(answer.recovered.behind, false);
    assert.equal(answer.end.buffer, '');
    assert.ok(answer.end.offset > answer.before.offset);
  }
});

test('failed opens spend no transcript budget and a failed read spends only the bytes it returned', () => {
  const [opens, read] = collect('budget');
  assert.equal(opens.total, 1024 * 1024);
  assert.deepEqual(opens.good, [262144, 262144, 262144, 262144]);
  assert.equal(read.total, 1024 * 1024);
  assert.deepEqual(read.good, [262144, 262144, 262144, 196608]);
});

test('metadata is cached until reset and a transient refresh failure retains the last valid toolUseId', () => {
  assert.deepEqual(collect('cache'), [
    ['toolu_original', 1, true], ['toolu_original', 1, false], ['toolu_original', 1, false],
    ['toolu_original', 2, true], ['toolu_refreshed', 3, false], ['toolu_refreshed', 3, false],
    [null, 4, true], ['toolu_returned', 5, false],
  ]);
});

test('macOS runs only the SSH descriptor-relative and sub-agent symlink Python tests', () => {
  const workflow = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../.github/workflows/build-windows.yml'), 'utf8'));
  const step = workflow.jobs.macos.steps.find(step => step.name === 'Test SSH descriptor-relative reads and symlink recovery');
  const filters = [...step.run.matchAll(/-k\s+(\S+)/g)].map(match => match[1]);
  const names = [...fs.readFileSync(path.join(__dirname, 'remote_worker_test.py'), 'utf8').matchAll(/def (test_\w+)\(/g)].map(match => match[1]);
  assert.deepEqual(names.filter(name => filters.some(filter => name.includes(filter))), [
    'test_claude_status_follows_the_named_sub_agents_in_the_session_folder_and_drops_the_rest',
    'test_sub_agent_reads_never_follow_a_link_out_of_the_session_folder',
  ]);
});
