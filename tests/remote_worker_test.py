import base64
import contextlib
import importlib.util
import io
import json
import queue
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import uuid
import time
from datetime import datetime, timezone

MODULE_PATH = Path(__file__).resolve().parents[1] / "integration" / "remote-worker.py"
spec = importlib.util.spec_from_file_location("remote_worker", MODULE_PATH)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


def _git_too_old():
    try: version = remote.Worker(lambda _: None).git_version()
    except Exception: return False
    return bool(version) and version < (2, 11)
GIT_TOO_OLD = _git_too_old()


class RemoteFilesTest(unittest.TestCase):
    def test_dispatch_events_use_the_same_authenticated_envelope_over_ssh(self):
        events = []
        self.worker.emit = events.append
        self.worker.listener = mock.MagicMock()
        payload = {"type": "dispatch-rate", "id": "22222222-2222-4222-8222-222222222222", "outputTokens": 50, "activeMs": 1000,
                   "projectId": self.worker.project_id, "sessionKey": self.worker.token}
        clients = []
        for value in ([], dict(payload, sessionKey="wrong"), dict(payload, projectId="other"), payload):
            client = mock.MagicMock()
            client.__enter__.return_value = client
            client.recv.return_value = json.dumps(value).encode("utf-8") + b"\n"
            clients.append((client, None))
        self.worker.listener.accept.side_effect = clients + [OSError("closed")]
        self.worker.events_loop()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], dict(payload, sequence=1))

    def test_dispatch_copy_and_bootstrap_exist_only_with_remote_node(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.worker.dispatch_source = "// synthetic dispatch helper\n"
        self.worker.dispatch_modules = {"features/agents/token-rate.cjs": "// synthetic shared meter\n"}
        self.worker.handoff_path = lambda: os.path.join(self.worker.temp, "handoff.md")
        with mock.patch.object(remote.shutil, "which", return_value=None):
            note = self.worker.startup_note("Read. {AGENTRIX_DISPATCH_NOTE}")
        self.assertIn("unavailable over SSH", note)
        self.assertIn("workers run unseen", note)
        self.assertFalse((Path(self.worker.temp) / "dispatch.cjs").exists())
        self.worker.dispatch_note = None
        with mock.patch.object(remote.shutil, "which", return_value="/bin/node"):
            note = self.worker.startup_note("Read. {AGENTRIX_DISPATCH_NOTE}")
        self.assertIn("Dispatch helper: node ", note)
        self.assertEqual((Path(self.worker.temp) / "dispatch.cjs").read_text(encoding="utf-8"), self.worker.dispatch_source)
        meter = Path(self.worker.temp) / "electron/features/agents/token-rate.cjs"
        self.assertEqual(meter.read_text(encoding="utf-8"), self.worker.dispatch_modules["features/agents/token-rate.cjs"])
        bootstrap = json.loads((Path(self.worker.temp) / "dispatch.json").read_text(encoding="utf-8"))
        self.assertEqual(bootstrap, {"pipeName": os.path.join(self.worker.temp, "events.sock"), "sessionKey": self.worker.token, "projectId": self.worker.project_id})
        if os.name == "posix":
            self.assertEqual(os.stat(Path(self.worker.temp) / "dispatch.json").st_mode & 0o777, 0o600)
            self.assertEqual(os.stat(meter).st_mode & 0o777, 0o600)

    def test_dispatch_modules_are_bounded_and_cannot_escape_the_runtime_folder(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.worker.dispatch_source = "// synthetic dispatch helper\n"
        for modules in ({"../escape.cjs": "bad"}, {"/absolute.cjs": "bad"}, {"module.cjs": None},
                        {"module.cjs": "x" * (256 * 1024 + 1)}, []):
            self.worker.dispatch_modules = modules
            with mock.patch.object(remote.shutil, "which", return_value="/bin/node"), self.assertRaises(ValueError):
                self.worker.install_dispatch()
            self.assertFalse((Path(self.worker.temp) / "dispatch.cjs").exists())

    def test_each_agent_launch_gets_a_fresh_note_and_stale_launches_cannot_replace_it(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.worker.handoff_path = lambda: os.path.join(self.worker.temp, "handoff.md")
        text = "---\nname: code-standard\ndescription: Code rules.\n---\nFollow the rules."
        bundle = {"files": [{"id": "builtin:code-standard", "name": "code-standard", "scope": "builtin", "text": text}],
                  "instructions": "First run: {AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md"}
        self.worker.skill_note_sequence = 1
        paths = self.worker.update_skill_note(1, bundle["instructions"], bundle)
        note_file = Path(self.worker.temp) / "skill-note.txt"
        self.assertIn("First run:", note_file.read_text(encoding="utf-8"))
        self.assertIn(paths["builtin:code-standard"], note_file.read_text(encoding="utf-8"))
        self.assertTrue(self.worker.skill_note_ready.is_set())
        self.worker.skill_note_sequence = 2
        self.worker.skill_note_ready.clear()
        with self.assertRaisesRegex(ValueError, "launch changed"):
            self.worker.update_skill_note(1, "stale note", bundle)
        self.assertFalse(self.worker.skill_note_ready.is_set())
        bundle = dict(bundle, instructions="Auto: {AGENTRIX_SKILLS}/builtin/code-standard/SKILL.md")
        self.worker.update_skill_note(2, bundle["instructions"], bundle)
        self.assertIn("Auto:", note_file.read_text(encoding="utf-8"))
        self.assertNotIn("First run", note_file.read_text(encoding="utf-8"))
        for filename in self.worker.skill_paths.values(): os.chmod(filename, 0o600)

    def test_launch_notification_waits_for_acknowledgment_without_printing(self):
        sockets = mock.MagicMock()
        client = sockets.socket.return_value.__enter__.return_value
        client.recv.return_value = b"\n"
        output = io.StringIO()
        with mock.patch.dict(sys.modules, {"socket": sockets}), mock.patch.dict(os.environ, {"AGENTRIX_SOCKET": "fixture", "AGENTRIX_TOKEN": "fixture"}), \
                mock.patch.object(sys, "argv", ["notify.py", "codex-started"]), contextlib.redirect_stdout(output):
            exec(compile(remote.NOTIFY_SOURCE, "notify.py", "exec"), {})
        names = [call[0] for call in client.mock_calls]
        self.assertLess(names.index("sendall"), names.index("recv"))
        client.recv.assert_called_once_with(1)
        self.assertEqual(output.getvalue(), "")

    @unittest.skipUnless(hasattr(remote.socket, "AF_UNIX"), "Unix-domain sockets are unavailable")
    def test_launch_helper_waits_for_the_host_note_before_continuing(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.worker.handoff_path = lambda: os.path.join(self.worker.temp, "handoff.md")
        socket_path = os.path.join(self.worker.temp, "note.sock")
        self.worker.listener = remote.socket.socket(remote.socket.AF_UNIX, remote.socket.SOCK_STREAM)
        self.worker.listener.bind(socket_path)
        self.worker.listener.listen()
        self.worker.listener.settimeout(0.1)
        events = queue.Queue()
        self.worker.emit = events.put
        thread = threading.Thread(target=self.worker.events_loop, daemon=True)
        thread.start()
        env = dict(os.environ, AGENTRIX_SOCKET=socket_path, AGENTRIX_TOKEN=self.worker.token)
        process = subprocess.Popen([sys.executable, "-c", remote.NOTIFY_SOURCE, "codex-started"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        event = events.get(timeout=5)["event"]
        self.assertIsNone(process.poll(), "launch waits until the host writes its note")
        self.worker.update_skill_note(event["sequence"], "Fresh launch note.", {"files": [], "instructions": "Auto skills."})
        stdout, stderr = process.communicate(timeout=5)
        self.assertEqual((process.returncode, stdout, stderr), (0, b"", b""))
        self.assertEqual((Path(self.worker.temp) / "skill-note.txt").read_text(encoding="utf-8"), "Fresh launch note.")
        self.worker.stop(); thread.join(timeout=2)

    def test_skills_are_copied_to_private_remote_paths_and_manifest_expands(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        text = "---\nname: model-routing\ndescription: Route models.\n---\nRead me.\n"
        self.worker.skills_bundle = {"files": [{"id": "builtin:model-routing", "name": "model-routing", "scope": "builtin", "text": text},
                                               {"id": "user:global", "name": "global", "scope": "global", "text": text}],
                                    "instructions": "Before any task, read and follow {AGENTRIX_SKILLS}/builtin/model-routing/SKILL.md. {AGENTRIX_AGENTS}"}
        with mock.patch.object(remote.shutil, "which", side_effect=lambda name: "/bin/claude" if name == "claude" else None):
            note = self.worker.install_skills(self.worker.skills_bundle["instructions"])
        filename = self.worker.skill_paths["builtin:model-routing"]
        self.assertEqual(Path(filename).read_text(encoding="utf-8"), text)
        self.assertEqual([file.name for file in Path(filename).parent.iterdir()], ["SKILL.md"])
        for file in self.worker.skill_paths.values():
            if os.name == "posix": self.assertEqual(os.stat(file).st_mode & 0o777, 0o400)
            os.chmod(file, 0o600)
        self.assertIn(filename, note)
        self.assertIn("Claude Code installed; Codex missing", note)
        self.assertNotIn("{AGENTRIX_", note)
        self.assertEqual((Path(self.worker.temp) / "skills/instructions.md").read_text(encoding="utf-8"), note)

    def test_remote_skill_names_cannot_escape_session_folder(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        self.worker.skills_bundle = {"files": [{"id": "bad", "name": "../escape", "scope": "global", "text": "bad"}]}
        with self.assertRaises(ValueError): self.worker.install_skills("note")

    def test_remote_skills_reject_attachments_and_invalid_bundles(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        for bundle in ([], {"files": "invalid"}, {"files": [None]}, {"files": [{"id": "user:test", "name": "test", "scope": "global", "text": "text", "assets": [{"path": "large"}]}]}):
            self.worker.skills_bundle = bundle
            with self.assertRaises(ValueError): self.worker.install_skills("note")

    def test_startup_note_truncates_after_expanding_every_placeholder(self):
        self.worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        note = "{AGENTRIX_SKILLS} " * 220 + "{AGENTRIX_HANDOFF} " * 80 + "{AGENTRIX_AGENTS}"
        folder = os.path.join(self.worker.temp, "skills").replace(os.sep, "/")
        handoff = "/synthetic/" + "handoff" * 30 + ".md"
        with mock.patch.object(self.worker, "handoff_path", return_value=handoff), mock.patch.object(remote.shutil, "which", return_value=None):
            result = self.worker.startup_note(note)
        expanded = note.replace("{AGENTRIX_SKILLS}", folder).replace("{AGENTRIX_HANDOFF}", handoff).replace("{AGENTRIX_AGENTS}", "Installed agents: Claude Code missing; Codex missing.")
        self.assertLess(len(note), 8000)
        self.assertGreater(len(expanded), 8000)
        self.assertEqual(result, expanded[:8000])
        self.assertNotIn("{AGENTRIX_", result)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentrix-worker-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.worker = remote.Worker(lambda _: None)
        self.worker.initialize({"path": str(self.root), "token": "test", "projectId": "test"})

    def tearDown(self):
        self.worker.stop()
        self.temp.cleanup()

    def claude_file(self):
        self.worker.claude_home = str(Path(self.temp.name) / "claude")
        folder = Path(self.worker.claude_home) / "projects" / "-srv-project"
        folder.mkdir(parents=True)
        return folder / "session.jsonl"

    def test_claude_hooks_match_local_states_fields_and_ignore_idle_notifications(self):
        def notify(kind, payload):
            client = mock.MagicMock()
            client.__enter__.return_value = client
            with mock.patch("sys.argv", ["notify.py", "claude-hook", kind]), mock.patch("sys.stdin", io.StringIO(json.dumps(payload))), \
                 mock.patch.dict(os.environ, {"AGENTRIX_TOKEN": "test", "AGENTRIX_SOCKET": "test.sock"}), \
                 mock.patch("os.getcwd", return_value="/srv/project"), mock.patch("socket.AF_UNIX", 1, create=True), mock.patch("socket.socket", return_value=client):
                try: exec(remote.NOTIFY_SOURCE, {})
                except SystemExit as error: self.assertEqual(error.code, 0)
            return json.loads(client.sendall.call_args[0][0]) if client.sendall.called else None
        payload = {"session_id": "session", "transcript_path": "/srv/claude/projects/project/session.jsonl", "prompt": "p" * 2100, "message": "m" * 400, "notification_type": "permission_prompt"}
        identities = []
        for kind, state in (("start", "working"), ("stop", "complete"), ("notify", "attention"), ("session", "session")):
            event = notify(kind, payload)
            self.assertEqual((event["type"], event["agent"], event["state"], event["sessionId"]), ("agent-activity", "claude", state, "session"))
            self.assertEqual(event["transcriptPath"], payload["transcript_path"])
            self.assertEqual(event["prompt"], "p" * 2000 if kind == "start" else None)
            self.assertEqual(event["message"], "m" * 300 if kind == "notify" else None)
            self.assertEqual(event["token"], "test"); self.assertTrue(event["eventId"].startswith("session:"))
            identities.append(event["eventId"])
        self.assertEqual(len(set(identities)), 4)
        self.assertIsNotNone(notify("notify", dict(payload, notification_type="elicitation_dialog")))
        for kind, hook in (("notify", dict(payload, notification_type="idle_prompt")), ("start", {}), ("unknown", payload)):
            self.assertIsNone(notify(kind, hook))

    def test_notify_shell_events_name_claude_and_default_to_codex(self):
        for args, expected in ((["codex-started", "--version", "claude"], {"agent": "claude", "command": "--version"}),
                               (["codex-exited", "7", "claude"], {"agent": "claude", "exitCode": 7}),
                               (["codex-started", ""], {"agent": "codex"}), (["codex-exited", "0"], {"agent": "codex", "exitCode": 0}),
                               (["shell-prompt", "0", "1"], {"codexAvailable": False, "claudeAvailable": True})):
            client = mock.MagicMock(); client.__enter__.return_value = client
            with mock.patch("sys.argv", ["notify.py"] + args), mock.patch.dict(os.environ, {"AGENTRIX_TOKEN": "test", "AGENTRIX_SOCKET": "test.sock"}), \
                 mock.patch("os.getcwd", return_value="/srv/project"), mock.patch("socket.AF_UNIX", 1, create=True), mock.patch("socket.socket", return_value=client):
                exec(remote.NOTIFY_SOURCE, {})
            event = json.loads(client.sendall.call_args[0][0])
            for key, value in expected.items(): self.assertEqual(event[key], value)

    def test_claude_wrapper_quotes_hook_commands_for_sh(self):
        python, notify = "/opt/python's tools/python3", "/tmp/agent's path/notify.py"
        source = remote.BASH_SOURCE.split("import json,shlex,sys\n", 1)[1].split("\nPY\n", 1)[0]
        output = io.StringIO()
        with mock.patch("sys.executable", python), mock.patch("sys.argv", ["-", notify]), contextlib.redirect_stdout(output):
            exec("import json,shlex,sys\n" + source, {})
        hooks = json.loads(output.getvalue())["hooks"]
        for name, kind in (("UserPromptSubmit", "start"), ("Stop", "stop"), ("Notification", "notify"), ("SessionStart", "session")):
            self.assertEqual(shlex.split(hooks[name][0]["hooks"][0]["command"]), [python, notify, "claude-hook", kind])

    def test_claude_status_reads_incrementally_and_preserves_tools_settings_and_queued_prompts(self):
        filename = self.claude_file()
        rows = [
            {"type": "user", "uuid": "u1", "message": {"content": "Remote prompt"}},
            {"type": "assistant", "uuid": "a1", "effort": "high", "perTurnEffort": "xhigh", "message": {"id": "msg-1", "model": "claude-test", "usage": {
                "speed": "fast", "input_tokens": 120, "cache_creation_input_tokens": 40, "cache_read_input_tokens": 80, "output_tokens": 15,
                "service_tier": "standard", "server_tool_use": {"web_search_requests": 1}, "cache_creation": {"ephemeral_5m_input_tokens": 40}, "other": 1}, "content": [
                {"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "Reading"},
                {"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "/srv/project/a.py"}},
                {"type": "tool_use", "id": "skill", "name": "Skill", "input": {"skill": "test-skill", "args": "check"}}]}},
            {"type": "assistant", "isSidechain": True, "message": {"content": "child"}},
            {"type": "attachment", "uuid": "queued", "attachment": {"type": "queued_command", "commandMode": "prompt", "prompt": [{"type": "text", "text": "Queued work"}, {"type": "image", "source": {"data": "hidden"}}]}},
        ]
        filename.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertTrue(status["historyDone"])
        self.assertEqual([row["uuid"] for row in status["records"]], ["u1", "a1", "queued"])
        reply = status["records"][1]
        self.assertEqual(reply["message"]["model"], "claude-test"); self.assertEqual(reply["effort"], "high")
        self.assertEqual(reply["perTurnEffort"], "xhigh")
        self.assertEqual(reply["message"]["id"], "msg-1")
        self.assertEqual(reply["message"]["usage"], {"speed": "fast", "input_tokens": 120, "cache_creation_input_tokens": 40, "cache_read_input_tokens": 80, "output_tokens": 15})
        self.assertEqual([block["type"] for block in reply["message"]["content"]], ["text", "tool_use", "tool_use"])
        result = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "read", "is_error": True, "content": "output" * 10000}]}}
        with filename.open("a", encoding="utf-8") as output: output.write(json.dumps(result))
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])
        with filename.open("a", encoding="utf-8") as output: output.write("\n")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertFalse(status["reset"])
        self.assertEqual(status["records"][0]["message"]["content"], [{"type": "tool_result", "tool_use_id": "read", "is_error": True, "content": ""}])
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])

    def test_claude_compaction_omits_invalid_usage_and_message_ids(self):
        for usage in (None, [], "invalid", {}, {"input_tokens": True, "cache_creation_input_tokens": 1.5, "cache_read_input_tokens": "2", "output_tokens": False, "speed": 1}):
            with self.subTest(usage=usage):
                kept = remote.compact_claude_record({"type": "assistant", "message": {"id": 1, "content": "Reply", "usage": usage}})
                self.assertEqual(kept["message"], {"role": None, "content": "Reply"})
        for usage in ({"speed": "fast"}, {"input_tokens": 0}):
            kept = remote.compact_claude_record({"type": "assistant", "message": {"content": "Reply", "usage": usage}})
            self.assertEqual(kept["message"]["usage"], usage)

    def test_claude_compaction_keeps_the_queue_of_messages_sent_while_it_works(self):
        kept = remote.compact_claude_record({"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-10-16T06:21:51.207Z", "sessionId": "s", "content": "hi"})
        self.assertEqual(kept, {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-10-16T06:21:51.207Z", "content": "hi"})
        self.assertEqual(remote.compact_claude_record({"type": "queue-operation", "operation": "dequeue", "timestamp": "t"}), {"type": "queue-operation", "operation": "dequeue", "timestamp": "t"})

    def test_real_claude_user_round_keeps_stops_queue_shapes_and_provenance_over_ssh(self):
        fixture = json.loads((MODULE_PATH.parent.parent / "tests" / "fixtures" / "claude-user-round-background.json").read_text(encoding="utf-8"))
        records = fixture["records"]
        pairs = [(record, remote.compact_claude_record(record)) for record in records]
        pairs = [(record, kept) for record, kept in pairs if kept is not None]
        for record, kept in pairs:
            self.assertEqual(kept.get("timestamp"), record.get("timestamp"))
            self.assertEqual(kept.get("message", {}).get("stop_reason"), record.get("message", {}).get("stop_reason"))
            for key in ("isMeta", "promptSource", "turnOrigin"):
                if key in record: self.assertEqual(kept[key], record[key])
            if "origin" in record: self.assertEqual(kept["origin"]["kind"], record["origin"]["kind"])
            if record["type"] == "queue-operation":
                self.assertEqual(kept.get("content"), record.get("content"))
                self.assertEqual(kept["operation"], record["operation"])
        self.assertEqual(sum(record.get("subtype") == "stop_hook_summary" for _, record in pairs), 3)
        script = r'''
const assert = require('node:assert/strict');
const { CompletionWork } = require('./electron/completion-work.cjs');
const pairs = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const trace = records => {
  const work = new CompletionWork();
  return records.map(record => {
    work.record(record, 'claude', 100000);
    return { turn: work.turn, endedAt: work.endedAt, reviewAt: work.reviewAt,
      tasks: [...work.tasks], notifications: [...work.notifications] };
  });
};
assert.deepEqual(trace(pairs.map(pair => pair[0])), trace(pairs.map(pair => pair[1])));
'''
        subprocess.run(["node", "-e", script], input=json.dumps(pairs), text=True, check=True, cwd=MODULE_PATH.parent.parent)

    def test_claude_compaction_keeps_whether_a_prompt_starts_the_conversation(self):
        first = remote.compact_claude_record({"type": "user", "parentUuid": None, "uuid": "a", "message": {"role": "user", "content": "hi"}})
        later = remote.compact_claude_record({"type": "user", "parentUuid": "a", "uuid": "b", "message": {"role": "user", "content": "more"}})
        self.assertIsNone(first["parentUuid"]); self.assertIn("parentUuid", first)
        self.assertEqual(later["parentUuid"], "a")

    def test_compaction_preserves_completion_identities_and_terminal_statuses_without_outputs(self):
        for result in ({"isAsync": True, "agentId": "agent", "status": "async_launched"}, {"backgroundTaskId": "shell"},
                       {"task": {"task_id": "shell", "status": "killed", "output": "private output"}}):
            kept = remote.compact_claude_record({"type": "user", "toolUseResult": dict(result, output="private output"),
                "message": {"content": [{"type": "tool_result", "tool_use_id": "launch", "content": "private output"}]}})
            self.assertNotIn("private output", json.dumps(kept))
            self.assertEqual(kept["toolUseResult"].get("backgroundTaskId"), result.get("backgroundTaskId"))
            if "task" in result: self.assertEqual(kept["toolUseResult"]["task"], {"task_id": "shell", "status": "killed"})
        stop = remote.compact_claude_record({"type": "system", "subtype": "stop_hook_summary", "timestamp": "t", "uuid": "stop"})
        self.assertEqual(stop["subtype"], "stop_hook_summary")
        ended = remote.compact_claude_record({"type": "assistant", "message": {"content": [], "stop_reason": "end_turn"}})
        self.assertEqual(ended["message"]["stop_reason"], "end_turn")
        error = remote.compact_claude_record({"type": "assistant", "isApiErrorMessage": True,
            "message": {"model": "<synthetic>", "stop_reason": None, "content": [{"type": "text", "text": "API request failed."}]}})
        self.assertTrue(error["isApiErrorMessage"])
        self.assertEqual(error["message"]["model"], "<synthetic>")
        for value in ({"agent_id": "child", "output": "private output"}, {"session_id": 42, "output": "private output"},
                      {"exit_code": 130, "output": "private output"}, {"status": {"child": {"completed": "private output"}}},
                      {"agents": [{"agent_name": "child", "agent_status": {"completed": "private output"}}]}):
            compact = remote.completion_output(json.dumps(value))
            self.assertNotIn("private output", compact)
            self.assertTrue(compact)
        self.assertEqual(remote.completion_output("ordinary stdout"), "")

    def test_completion_history_replays_the_record_skipped_at_an_exact_tail_boundary(self):
        first = b'{"type":"system"}\n'
        launch = b'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","id":"boundary","input":{"run_in_background":true}}]}}\n'
        history, received = remote.CompletionHistory(len(first)), []
        self.assertTrue(history.read(io.BytesIO(first + launch), received.append))
        self.assertEqual(received[-1]["message"]["content"][0]["id"], "boundary")

    def test_completion_history_keeps_receipts_after_large_valid_outputs(self):
        record = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "launch", "content": "x" * (2 * 1024 * 1024)}]},
                  "toolUseResult": {"backgroundTaskId": "shell"}}
        data = (json.dumps(record) + "\n").encode()
        history, received = remote.CompletionHistory(len(data) - 1), []
        self.assertTrue(history.read(io.BytesIO(data), lambda record: received.append(remote.compact_claude_record(record))))
        self.assertFalse(history.uncertain); self.assertEqual(received[0]["toolUseResult"]["backgroundTaskId"], "shell")

    def test_completion_replay_cannot_claim_success_if_the_record_budget_discards_an_old_launch(self):
        reader = remote.CodexActivityReader(str(self.root), str(self.root), 1)
        reader.work_history = remote.CompletionHistory(0)
        for number in range(20001):
            reader.record({"type": "response_item", "payload": {"type": "function_call", "call_id": str(number), "name": "test", "arguments": "{}"}}, True)
        self.assertEqual(len(reader.outbox), 20000)
        self.assertTrue(reader.take()["completionUncertain"])

    def test_completion_history_recovers_launches_and_ends_before_the_remote_tail_for_both_agents(self):
        def row(record): return (json.dumps(record) + "\n").encode()
        padding = row({"padding": "x" * 8192})
        for agent in ("claude", "codex"):
            with self.subTest(agent=agent):
                launch = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "launch", "name": "Agent", "input": {"run_in_background": True}}]}} if agent == "claude" else {
                    "type": "response_item", "payload": {"type": "function_call", "call_id": "launch", "name": "spawn_agent", "arguments": "{}"}}
                end = {"type": "queue-operation", "operation": "enqueue", "content": "<task-notification><task-id>launch</task-id><status>stopped</status></task-notification>"} if agent == "claude" else {
                    "type": "response_item", "payload": {"type": "function_call_output", "call_id": "launch", "output": '{"agent_id":"child"}'}}
                if agent == "claude":
                    filename = self.claude_file(); reader = remote.ClaudeTranscriptReader(str(filename), 1); compact = remote.compact_claude_record
                else:
                    home = Path(self.temp.name) / "history-codex"; (home / "sessions").mkdir(parents=True)
                    identity = str(uuid.uuid4()); filename = home / "sessions" / ("rollout-" + identity + ".jsonl")
                    reader = remote.CodexActivityReader(str(self.root), str(home), 1); compact = remote.compact_record
                prefix = row(launch) + row(end)
                if agent == "codex": prefix = row({"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}}) + prefix
                filename.write_bytes(prefix + padding * ((remote.HISTORY_WINDOW + remote.LIVE_READ_LIMIT) // len(padding) + 2) + row({"type": "system"}))
                received, done = [], False
                for _ in range(10):
                    reader.read(); status = reader.take(); received.extend(status["records"])
                    if status["historyDone"]: done = True; break
                self.assertTrue(done)
                prefix_records = [record for record in received if record.get("workOnly")]
                for expected in (compact(launch), compact(end)):
                    self.assertIn(dict(expected, workOnly=True), prefix_records)

    def test_claude_queue_compaction_keeps_text_blocks_cancellations_and_provenance(self):
        content = [{"type": "text", "text": "Queued work"}, {"type": "image", "source": {"data": "hidden"}}]
        for operation in ("enqueue", "remove", "dequeue", "popAll", "popOne", "clear"):
            kept = remote.compact_claude_record({"type": "queue-operation", "operation": operation, "content": content,
                                                "reason": "cleared_on_cancel", "origin": {"kind": "peer"}, "humanTurn": False})
            self.assertEqual(kept["content"], [{"type": "text", "text": "Queued work"}])
            self.assertEqual(kept["reason"], "cleared_on_cancel")
            self.assertEqual(kept["origin"], {"kind": "peer"}); self.assertFalse(kept["humanTurn"])
        kept = remote.compact_claude_record({"type": "user", "turnOrigin": "peer", "message": {"content": "Peer text"}})
        self.assertEqual(kept["turnOrigin"], "peer")

    def test_claude_usage_reset_fixture_preserves_machine_provenance_in_status_and_history(self):
        fixture = json.loads((MODULE_PATH.parent.parent / "tests" / "fixtures" / "claude-usage-reset.json").read_text(encoding="utf-8"))
        records = fixture["records"]
        kept = [remote.compact_claude_record(record) for record in records]
        self.assertEqual(kept[0]["content"], records[0]["content"])
        self.assertNotIn("content", kept[1])
        for key in ("isMeta", "origin", "promptSource", "turnOrigin"):
            self.assertEqual(kept[2][key], records[2][key])
        filename = self.claude_file()
        filename.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertEqual(status["records"], kept)
        history = remote.history_records("/srv/project", str(self.root / "absent-codex"), self.worker.claude_home)
        historical = history["claude"][0]["records"]
        self.assertFalse(any(record["type"] == "queue-operation" for record in historical))
        self.assertEqual(historical[0], kept[2])

    def test_claude_status_resets_on_replacement_truncation_or_new_run(self):
        filename = self.claude_file()
        def row(text): return json.dumps({"type": "user", "message": {"content": text}}) + "\n"
        filename.write_text(row("old"), encoding="utf-8")
        self.worker.claude_status(str(filename), 1000)
        filename.rename(filename.with_suffix(".old"))
        filename.write_text(row("replacement longer than old"), encoding="utf-8")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertEqual(status["records"][0]["message"]["content"], "replacement longer than old")
        filename.write_text(row("short"), encoding="utf-8")
        self.assertTrue(self.worker.claude_status(str(filename), 1000)["reset"])
        self.assertTrue(self.worker.claude_status(str(filename), 2000)["reset"])

    def test_claude_status_refuses_paths_outside_projects_and_invalid_times(self):
        filename = self.claude_file()
        filename.write_text("{}\n", encoding="utf-8")
        for path in (None, "session.jsonl", str(self.root / "outside.jsonl"), str(filename.parent.parent),
                     str(filename.parent / ".." / ".." / "outside.jsonl"), str(Path(self.worker.claude_home) / "projects-other" / "session.jsonl")):
            with self.assertRaises(ValueError): self.worker.claude_status(path, 1000)
        for since in (None, "1000", 0, -1):
            with self.assertRaises(ValueError): self.worker.claude_status(str(filename), since)
        missing = filename.with_name("missing.jsonl")
        status = self.worker.claude_status(str(missing), 1000)
        self.assertEqual(status["records"], []); self.assertFalse(status["historyDone"])

    @unittest.skipUnless(os.name == "posix", "the remote side runs on Linux and macOS")
    def test_claude_status_refuses_symlinks_outside_projects(self):
        filename = self.claude_file()
        outside = self.root / "outside.jsonl"; outside.write_text("{}\n", encoding="utf-8")
        filename.symlink_to(outside)
        with self.assertRaises(ValueError): self.worker.claude_status(str(filename), 1000)

    def test_claude_status_uses_history_window_and_drains_response_budget_before_history_done(self):
        filename = self.claude_file()
        def row(text): return (json.dumps({"type": "user", "message": {"content": text}}) + "\n").encode()
        filename.write_bytes(row("excluded") + (json.dumps({"padding": "x" * (remote.HISTORY_WINDOW + 1000)}) + "\n").encode()
                             + row("recent") + row("a" * remote.RECORD_TEXT_LIMIT) * 20)
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertFalse(status["historyDone"])
        work_records = [record for record in status["records"] if record.get("workOnly")]
        self.assertEqual(work_records[0]["message"]["content"], "excluded")
        status = self.worker.claude_status(str(filename), 1000)
        while not status["records"]: status = self.worker.claude_status(str(filename), 1000)
        self.assertFalse(status["historyDone"])
        self.assertEqual(status["records"][0]["message"]["content"], "recent")
        self.assertLessEqual(len(json.dumps(status)), remote.RECORDS_BUDGET + 100)
        next_status = self.worker.claude_status(str(filename), 1000)
        self.assertFalse(next_status["reset"]); self.assertTrue(next_status["historyDone"])
        self.assertEqual(len(status["records"]) + len(next_status["records"]), 21)
        before = self.worker.claude_reader.offset
        with filename.open("ab") as output:
            output.write((json.dumps({"padding": "x" * (remote.LIVE_READ_LIMIT + 1000)}) + "\n").encode() + row("live"))
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])
        self.assertEqual(self.worker.claude_reader.offset - before, remote.LIVE_READ_LIMIT)
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"][0]["message"]["content"], "live")

    @unittest.skipIf(GIT_TOO_OLD, "the Git panel needs Git 2.11; older Git is named instead")
    def test_git_reads_status_history_and_commit_paths_without_mutation(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=str(self.root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        self.assertFalse(self.worker.git("status")["repository"])
        git("init"); git("symbolic-ref", "HEAD", "refs/heads/main")
        git("config", "user.name", "测试 User")
        git("config", "user.email", "test@example.invalid")
        git("config", "core.autocrlf", "false")
        self.assertEqual(self.worker.git("history", 0)["output"], "")
        (self.root / "sub").mkdir()
        (self.root / "sub/中文 文件.txt").write_text("base", encoding="utf-8")
        (self.root / "outside.txt").write_text("outside", encoding="utf-8")
        git("add", "."); git("commit", "-m", "第一次提交")
        commit = git("rev-parse", "HEAD").decode().strip()
        (self.root / "sub/中文 文件.txt").write_text("changed", encoding="utf-8")
        (self.root / "新建.txt").write_text("new", encoding="utf-8")
        before = (self.root / ".git/index").read_bytes()
        status = self.worker.git("status")
        self.assertIn("sub/中文 文件.txt\0", status["output"])
        self.assertIn("? 新建.txt\0", status["output"])
        self.assertEqual((self.root / ".git/index").read_bytes(), before)
        self.assertIn(commit + "\0", self.worker.git("history", 0)["output"])
        self.assertIn("第一次提交", self.worker.git("history", 0)["output"])
        self.assertIn("sub/中文 文件.txt\0", self.worker.git("files", commit)["output"])
        self.worker.root = str(self.root / "sub")
        git("config", "diff.relative", "true")
        self.assertEqual(self.worker.git("status")["prefix"], "sub/")
        self.assertNotIn("outside.txt", self.worker.git("files", commit)["output"])
        with self.assertRaises(ValueError): self.worker.git("files", "--output=outside")
        with self.assertRaises(ValueError): self.worker.git("history", -1)

    @unittest.skipIf(GIT_TOO_OLD, "the Git panel needs Git 2.11; older Git is named instead")
    def test_signed_history_ignores_user_signature_display_setting(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=str(self.root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
        git("init"); git("symbolic-ref", "HEAD", "refs/heads/main")
        (self.root / "signed.txt").write_text("signed change", encoding="utf-8")
        git("add", ".")
        tree = git("write-tree")
        raw = f"tree {tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid-test-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n"
        obj = Path(self.temp.name) / "signed-commit"
        obj.write_bytes(raw.encode())
        commit = git("hash-object", "-t", "commit", "-w", str(obj))
        git("update-ref", "refs/heads/main", commit)
        git("config", "log.showSignature", "true")
        fields = self.worker.git("history", 0)["output"].split("\0")
        self.assertEqual(fields[0], commit)
        self.assertEqual(fields[5], "signed fixture")
        self.assertEqual(self.worker.git("files", commit)["output"], "A\0signed.txt\0")

    def test_directory_and_media_reads(self):
        (self.root / "src").mkdir()
        (self.root / "中文.txt").write_text("中文文件", encoding="utf-8")
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
        (self.root / "image-without-extension").write_bytes(png)
        (self.root / "page.html").write_text("<h1>Remote page</h1>", encoding="utf-8")
        (self.root / "README.md").write_text("# 远程 Markdown\n\n**正文**", encoding="utf-8")
        (self.root / "clip.mp4").write_bytes(b"video fixture")
        listing = self.worker.directory("", 0)
        self.assertEqual(listing["entries"][0]["name"], "src")
        self.assertEqual(self.worker.preview("中文.txt", 0)["content"], "中文文件")
        self.assertEqual(self.worker.preview("image-without-extension", 0)["kind"], "image")
        self.assertEqual(self.worker.preview("page.html", 0)["kind"], "html")
        self.assertEqual(self.worker.preview("README.md", 0)["kind"], "markdown")
        self.assertEqual(self.worker.preview("clip.mp4", 0)["kind"], "video")
        self.assertEqual(base64.b64decode(self.worker.read("中文.txt", 0, 6)), "中文".encode())

    def test_parent_activity_ignores_child_and_stale_completion(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        parent, child = str(uuid.uuid4()), str(uuid.uuid4())
        def event(kind, turn):
            return json.dumps({"type": "event_msg", "timestamp": datetime.now(timezone.utc).isoformat(), "payload": {"type": kind, "turn_id": turn}}) + "\n"
        filename = sessions / ("rollout-" + parent + ".jsonl")
        filename.write_text(json.dumps({"type": "session_meta", "payload": {"id": parent, "cwd": str(self.root), "source": "cli"}}) + "\n" + event("task_started", "parent"), encoding="utf-8")
        (sessions / ("rollout-" + child + ".jsonl")).write_text(json.dumps({"type": "session_meta", "payload": {"id": child, "cwd": str(self.root), "source": {"subagent": "parent"}}}) + "\n" + event("task_complete", "child"), encoding="utf-8")
        reader = remote.CodexActivityReader(str(self.root), str(home), time.time() * 1000)
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write(event("task_complete", "old"))
        self.assertEqual(reader.read()["state"], "working")
        completion = event("task_complete", "parent")
        with filename.open("a", encoding="utf-8") as output: output.write(completion[:-1])
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write("\n")
        self.assertEqual(reader.read()["state"], "complete")

    def test_conversation_records_go_back_compacted_with_the_status(self):
        # The reading view on the other computer gets the messages, the tools called and which finished; outputs,
        # reasoning and instructions stay here. A new file starts its conversation over; history ends once all is sent.
        home = Path(self.temp.name) / "conversation-home"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        filename = sessions / ("rollout-" + identity + ".jsonl")
        at = datetime.now(timezone.utc).isoformat()
        rows = [
            {"type": "session_meta", "timestamp": at, "payload": {"id": identity, "cwd": str(self.root), "source": "cli", "base_instructions": {"text": "x" * 50000}}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "task_started", "turn_id": "t1"}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u1", "content": [{"type": "text", "text": "预处理太慢"}, {"type": "image", "image_url": "data:" + "y" * 90000}]}}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "reasoning", "encrypted_content": "z" * 80000}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "c1", "input": "tools.exec_command({cmd: \"pytest -q\"})"}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": "o" * 70000}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "id": "a1", "content": [{"type": "text", "text": "| 节点 | 耗时 |\n| 预处理 | 0.51 |"}]}}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "token_count", "info": {"total": 1}}},
        ]
        filename.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        reader = remote.CodexActivityReader(str(self.root), str(home), 0, identity[:29])
        snapshot = reader.read()
        answer = reader.take()
        self.assertEqual(snapshot["state"], "working")
        self.assertTrue(answer["reset"]); self.assertTrue(answer["historyDone"])
        kinds = [(record["type"], record["payload"].get("type")) for record in answer["records"]]
        self.assertEqual(kinds, [("session_meta", None), ("event_msg", "task_started"), ("event_msg", "item_completed"), ("response_item", "custom_tool_call"), ("response_item", "custom_tool_call_output"), ("event_msg", "item_completed"), ("event_msg", "token_count")])
        self.assertEqual(answer["records"][-1], {"type": "event_msg", "timestamp": at, "payload": {"type": "token_count", "info": {}}})
        self.assertEqual(answer["records"][0]["payload"], {"id": identity, "cwd": str(self.root), "source": "cli"})
        self.assertEqual(answer["records"][2]["payload"]["item"]["content"], [{"type": "text", "text": "预处理太慢"}])
        self.assertEqual(answer["records"][4]["payload"], {"type": "custom_tool_call_output", "call_id": "c1"})
        self.assertLess(len(json.dumps(answer)), 4000)
        # Later growth comes with the next status, without starting over.
        with filename.open("a", encoding="utf-8") as output: output.write(json.dumps({"type": "event_msg", "timestamp": at, "payload": {"type": "agent_message", "message": "完成"}}) + "\n")
        reader.read()
        later = reader.take()
        self.assertFalse(later["reset"])
        self.assertEqual([record["payload"].get("message") for record in later["records"]], ["完成"])

    def test_compacted_records_keep_the_model_effort_and_fast_mode(self):
        turn = remote.compact_record({"type": "turn_context", "timestamp": "t", "payload": {"cwd": "/srv", "model": "gpt-6.1-sol", "effort": "high", "collaboration_mode": {"settings": {"developer_instructions": "long"}}}})
        self.assertEqual(turn["payload"], {"cwd": "/srv", "model": "gpt-6.1-sol", "effort": "high"})
        applied = remote.compact_record({"type": "event_msg", "timestamp": "t", "payload": {"type": "thread_settings_applied", "thread_settings": {
            "model": "gpt-6.1-sol", "service_tier": "priority", "reasoning_effort": "high", "cwd": "/srv", "collaboration_mode": {"settings": {"developer_instructions": "long"}}}}})
        self.assertEqual(applied["payload"], {"type": "thread_settings_applied", "thread_settings": {"model": "gpt-6.1-sol", "reasoning_effort": "high", "service_tier": "priority"}})
        self.assertEqual(remote.compact_record({"type": "turn_context", "payload": {"cwd": "/srv"}})["payload"], {"cwd": "/srv"})

    def test_session_meta_keeps_the_model_provider(self):
        payload = {"id": "session", "cwd": "/srv", "source": "cli", "model_provider": "openai", "base_instructions": {"text": "hidden"}}
        self.assertEqual(remote.compact_record({"type": "session_meta", "timestamp": "t", "payload": payload}), {
            "type": "session_meta", "timestamp": "t", "payload": {"id": "session", "cwd": "/srv", "source": "cli", "model_provider": "openai"}})
        for provider in (None, 1, True, {}):
            with self.subTest(provider=provider):
                self.assertNotIn("model_provider", remote.compact_record({"type": "session_meta", "payload": dict(payload, model_provider=provider)})["payload"])

    def test_token_count_keeps_only_context_usage_and_rate_limit_windows(self):
        usage = {"input_tokens": 23821304, "cached_input_tokens": 21937920, "cache_write_input_tokens": 0,
                 "output_tokens": 77102, "reasoning_output_tokens": 43935, "total_tokens": 23898406}
        window = {"used_percent": 18, "window_minutes": 10080, "resets_at": 1792472784}
        record = {"type": "event_msg", "timestamp": "t", "payload": {"type": "token_count", "extra": "hidden",
            "info": {"total_token_usage": usage, "last_token_usage": usage, "model_context_window": 828400, "extra": "hidden"},
            "rate_limits": {"limit_id": "codex", "limit_name": None, "primary": dict(window, extra="hidden"), "secondary": None,
                            "credits": {"has_credits": True, "unlimited": False, "balance": "62500.0000000000"}, "plan_type": None}}}
        expected_usage = {"input_tokens": 23821304, "cached_input_tokens": 21937920, "output_tokens": 77102, "reasoning_output_tokens": 43935, "total_tokens": 23898406}
        self.assertEqual(remote.compact_record(record), {"type": "event_msg", "timestamp": "t", "payload": {"type": "token_count",
            "info": {"total_token_usage": expected_usage, "last_token_usage": expected_usage, "model_context_window": 828400},
            "rate_limits": {"primary": window, "secondary": None}}})

    def test_token_count_allows_null_info_and_missing_rate_limits(self):
        for info in (None, [], "invalid", 1):
            for limits in ({}, {"rate_limits": None}, {"rate_limits": []}, {"rate_limits": "invalid"}):
                with self.subTest(info=info, limits=limits):
                    payload = dict({"type": "token_count", "info": info}, **limits)
                    self.assertEqual(remote.compact_record({"type": "event_msg", "timestamp": "t", "payload": payload}), {
                        "type": "event_msg", "timestamp": "t", "payload": {"type": "token_count", "info": None}})

    def test_token_count_rejects_invalid_numbers_and_usage_dicts(self):
        record = {"type": "event_msg", "timestamp": "t", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": True, "cached_input_tokens": "2", "output_tokens": 1.5, "reasoning_output_tokens": False, "total_tokens": 0},
            "last_token_usage": None, "model_context_window": True},
            "rate_limits": {"primary": {"used_percent": False, "window_minutes": True, "resets_at": 1.5},
                            "secondary": {"used_percent": 18.5, "window_minutes": 0, "resets_at": 1792472784}}}}
        self.assertEqual(remote.compact_record(record), {"type": "event_msg", "timestamp": "t", "payload": {"type": "token_count",
            "info": {"total_token_usage": {"total_tokens": 0}}, "rate_limits": {"primary": {}, "secondary": {"used_percent": 18.5, "window_minutes": 0, "resets_at": 1792472784}}}})
        record["payload"]["info"] = {"total_token_usage": [], "last_token_usage": "invalid", "model_context_window": 1.5}
        record["payload"]["rate_limits"] = {"primary": [], "secondary": "invalid"}
        self.assertEqual(remote.compact_record(record)["payload"], {"type": "token_count", "info": {}, "rate_limits": {"primary": None, "secondary": None}})

    def test_history_records_excludes_token_counts_before_spending_its_budget(self):
        home = Path(self.temp.name) / "history-home"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        rows = [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "agent_message", "message": "Earlier work"}},
        ]
        token_count = {"type": "event_msg", "payload": {"type": "token_count", "info": {"model_context_window": 828400}}}
        filename = sessions / ("rollout-" + identity + ".jsonl")
        filename.write_text("".join(json.dumps(row) + "\n" for row in rows[:1] + [token_count] * 50 + rows[1:] + [token_count] * 50), encoding="utf-8")
        expected = [remote.compact_record(row) for row in rows]
        found = remote.history_records(str(self.root), str(home), str(Path(self.temp.name) / "claude-history"), budget=len(json.dumps(expected, ensure_ascii=True)))
        self.assertEqual(found, {"codex": [{"id": identity, "records": expected}], "claude": []})

    @unittest.skipUnless(os.name == "posix", "the remote side runs on Linux and macOS")
    def test_document_reads_a_markdown_file_anywhere_and_nothing_else(self):
        note = Path(self.temp.name) / "memory" / "CONTEXT.md"
        note.parent.mkdir()
        note.write_text("# 背景\n" + "x" * 100, encoding="utf-8")
        found = self.worker.document(str(note), 8192)
        self.assertEqual(base64.b64decode(found["data"]).decode("utf-8"), note.read_text(encoding="utf-8"))
        self.assertEqual(found["size"], note.stat().st_size)
        self.assertEqual(len(base64.b64decode(self.worker.document(str(note), 4)["data"])), 4)
        for wrong in (str(note.with_suffix(".txt")), "CONTEXT.md", str(note) + "\0.md"):
            with self.assertRaises(ValueError): self.worker.document(wrong, 10)
        with self.assertRaises(ValueError): self.worker.document(str(note), -1)
        with self.assertRaises(OSError): self.worker.document(str(note.parent / "missing.md"), 10)
        (note.parent / "folder.md").mkdir()
        with self.assertRaises((ValueError, OSError)): self.worker.document(str(note.parent / "folder.md"), 10)

    @unittest.skipUnless(hasattr(os, "getuid"), "the remote side runs on Linux and macOS")
    def test_history_and_handoff_carry_the_folders_earlier_work(self):
        codex_home, claude_home = Path(self.temp.name) / "codex-h", Path(self.temp.name) / "claude-h"
        day = codex_home / "sessions" / "2026" / "10" / "12"
        day.mkdir(parents=True)
        identity = str(uuid.uuid4())
        (day / ("rollout-" + identity + ".jsonl")).write_text("".join(json.dumps(row) + "\n" for row in [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u", "content": [{"type": "text", "text": "预处理太慢"}]}}},
            {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c", "output": "x" * 50000}},
        ]), encoding="utf-8")
        folder = claude_home / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.root))
        folder.mkdir(parents=True)
        (folder / "s1.jsonl").write_text("".join(json.dumps(row) + "\n" for row in [
            {"type": "user", "uuid": "u1", "timestamp": "2026-10-12T01:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "加上限流"}, {"type": "image", "source": {"data": "y" * 40000}}]}},
            {"type": "assistant", "uuid": "a1", "timestamp": "2026-10-12T01:00:01Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Edit", "input": {"file_path": "/srv/a.py", "new_string": "z" * 5000}}]}},
            {"type": "user", "uuid": "r1", "timestamp": "2026-10-12T01:00:02Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "w" * 30000}]}},
        ]), encoding="utf-8")
        found = remote.history_records(str(self.root), str(codex_home), str(claude_home))
        self.assertEqual([session["id"] for session in found["codex"]], [identity])
        self.assertEqual([session["id"] for session in found["claude"]], ["s1"])
        claude = found["claude"][0]["records"]
        self.assertEqual(claude[0]["message"]["content"], [{"type": "text", "text": "加上限流"}])
        self.assertEqual(claude[1]["message"]["content"][0]["input"]["file_path"], "/srv/a.py")
        self.assertLessEqual(len(claude[1]["message"]["content"][0]["input"]["new_string"]), 600)
        self.assertLess(len(json.dumps(found)), 8000, "outputs and pictures stay on this computer")
        # The handoff lies in a private folder, at the path the note names; empty removes it.
        self.worker.project_id = "terminal-1"
        path = self.worker.write_handoff("# Earlier work\n")
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        self.assertEqual(path, self.worker.handoff_path())
        self.assertEqual(Path(path).read_text(encoding="utf-8"), "# Earlier work\n")
        self.assertEqual(os.stat(os.path.dirname(path)).st_mode & 0o777, 0o700)
        self.assertIsNone(self.worker.write_handoff(""))
        self.assertFalse(os.path.exists(path))

    def test_transcript_window_history_live_budget_and_rebinding(self):
        home = Path(self.temp.name) / "window-home"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        filename = sessions / ("rollout-" + identity + ".jsonl")
        def line(record): return (json.dumps(record) + "\n").encode()
        def event(kind, turn): return line({"type": "event_msg", "payload": {"type": kind, "turn_id": turn}})
        meta = line({"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}})
        # The first bytes at the seek position look like valid JSON but belong to a cut line.
        cut = line({"cut": True})
        complete = event("task_complete", "excluded")
        padding = line({"padding": "x" * (remote.HISTORY_WINDOW - len(cut) - len(complete) - len(line({"padding": ""})))})
        filename.write_bytes(meta + event("task_started", "excluded") + b"invalid partial line " + cut + padding + complete)
        reader = remote.CodexActivityReader(str(self.root), str(home), 0, identity)
        seen = []
        original = reader.record
        def record(value, work_only=False):
            if not work_only: seen.append(value)
            original(value, work_only)
        reader.record = record
        self.assertEqual(reader.read()["state"], "unknown")
        self.assertFalse(reader.history_pending)
        self.assertEqual(seen, [{"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "excluded"}}])
        self.assertEqual(remote.recent_session(str(self.root), str(home), identity)["id"], identity)
        before = reader.offset
        with filename.open("ab") as output:
            output.write(event("task_started", "live") + line({"padding": "x" * (remote.LIVE_READ_LIMIT + 1000)}) + event("task_complete", "live"))
        self.assertIsNone(reader.read())
        self.assertEqual(reader.offset - before, remote.LIVE_READ_LIMIT)
        self.assertEqual(reader.read()["state"], "complete")
        # Shrink but remain larger than a window; the old turn must not survive.
        filename.write_bytes(meta + line({"padding": "x" * (remote.HISTORY_WINDOW + 1000)}) + complete)
        result = reader.read()
        while result is None: result = reader.read()
        self.assertEqual(result["state"], "unknown")
        filename.rename(filename.with_suffix(".old"))
        filename.write_bytes(meta + line({"padding": "x" * (remote.HISTORY_WINDOW + 2000)}) + event("task_started", "replacement"))
        result = reader.read()
        while result is None: result = reader.read()
        self.assertEqual(result["state"], "working")
        self.assertEqual(reader.snapshot["turnId"], "replacement")

    def test_large_unicode_pages_are_lossless(self):
        content = "A" * (remote.PAGE_BYTES - 1) + "中文🙂\ufeff内容\n" * 40000
        for encoding, bom in (("utf-8", b""), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            (self.root / "large.txt").write_bytes(bom + content.encode(encoding))
            first = self.worker.preview("large.txt", 0)
            pages = [self.worker.preview("large.txt", index) for index in range(first["page"]["count"])]
            self.assertEqual("".join(page["content"] for page in pages), content)
            for left, right in zip(pages, pages[1:]): self.assertEqual(left["page"]["byteEnd"], right["page"]["byteStart"])

    def test_page_edits_preserve_unicode_encoding_and_reject_conflicts(self):
        for encoding, bom in (("utf-8", b"\xef\xbb\xbf"), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            original = bom + ("中文🙂 line\r\n" * 70000).encode(encoding)
            filename = self.root / "editable.txt"
            filename.write_bytes(original)
            preview = self.worker.preview("editable.txt", 1)
            replacement = "edited\n第二行🙂"
            payload = base64.b64encode(replacement.encode("utf-8")).decode("ascii")
            self.worker.save_file("editable.txt", 1, preview["revision"], payload)
            expected = original[:preview["page"]["byteStart"]] + replacement.replace("\n", "\r\n").encode(encoding) + original[preview["page"]["byteEnd"]:]
            self.assertEqual(filename.read_bytes(), expected)
            current = self.worker.preview("editable.txt", 0)
            filename.write_text("external content", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "其他程序修改"):
                self.worker.save_file("editable.txt", 0, current["revision"], payload)
            self.assertEqual(filename.read_text(encoding="utf-8"), "external content")

    def test_page_boundaries_preserve_crlf_and_unicode_when_editing_either_side(self):
        filename = self.root / "boundary.txt"
        for encoding, bom in (("utf-8", b""), ("utf-8", b"\xef\xbb\xbf"), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            units = remote.PAGE_BYTES // (1 if encoding == "utf-8" else 2)
            originals = ["x" * (units - 1) + "\r\n" + "y" * (units - 2) + "\r\nTAIL中文🙂\r\nlast"]
            # A UTF-16 smile uses a surrogate pair; UTF-8 covers every interior byte of both widths.
            originals += ["x" * (units - offset) + "🙂\r\nTAIL中文\r\nlast" for offset in ([1, 2, 3] if encoding == "utf-8" else [1])]
            if encoding == "utf-8": originals += ["x" * (units - offset) + "中\r\nTAIL\r\nlast" for offset in (1, 2)]
            for original in originals:
                with self.subTest(encoding=encoding, length=len(original), bom=bom):
                    filename.write_bytes(bom + original.encode(encoding))
                    first = self.worker.preview("boundary.txt", 0)
                    pages = [self.worker.preview("boundary.txt", index) for index in range(first["page"]["count"])]
                    self.assertEqual("".join(page["content"] for page in pages), original)
                    self.assertEqual(pages[0]["page"]["byteStart"], len(bom))
                    self.assertEqual(pages[-1]["page"]["byteEnd"], filename.stat().st_size)
                    for left, right in zip(pages, pages[1:]):
                        self.assertEqual(left["page"]["byteEnd"], right["page"]["byteStart"])
                        self.assertFalse(left["content"].endswith("\r") and right["content"].startswith("\n"))
                    expected = original
                    for index in range(len(pages)):
                        page = self.worker.preview("boundary.txt", index)
                        before, after = ("x", "X") if index == 0 else ("last", "LAST") if index == len(pages) - 1 else ("y", "Y")
                        self.assertIn(before, page["content"])
                        edited = page["content"].replace("\r\n", "\n").replace(before, after, 1)
                        payload = base64.b64encode(edited.encode("utf-8")).decode("ascii")
                        self.worker.save_file("boundary.txt", index, page["revision"], payload)
                        expected = expected.replace(before, after, 1)
                        self.assertEqual(filename.read_bytes(), bom + expected.encode(encoding))

    def test_traversal_and_non_files_are_rejected(self):
        for filename in ("../outside", "/etc/passwd", "bad\0path", "a\\b"):
            with self.assertRaises(ValueError): self.worker.resolve(filename)
        with self.assertRaises(ValueError): self.worker.preview("", 0)
        with self.assertRaises(ValueError): self.worker.read("file", 0, remote.MAX_READ + 1)
        if os.name == "posix":
            outside = Path(self.temp.name) / "outside"
            outside.write_text("private", encoding="utf-8")
            (self.root / "escape").symlink_to(outside)
            with self.assertRaises(ValueError): self.worker.preview("escape", 0)

    def test_recovery_only_reads_the_matching_interactive_session(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        records = [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "event_msg", "payload": {"type": "turn_aborted"}},
        ]
        filename = sessions / "rollout-test.jsonl"
        filename.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
        result = remote.recent_session(os.path.realpath(self.root), str(home))
        self.assertEqual(result["id"], identity)
        self.assertEqual(result["state"], "interrupted")
        with filename.open("a", encoding="utf-8") as output: output.write('\n{"type":"event_msg","payload":{"type":"task_complete"}}\n')
        self.assertEqual(remote.recent_session(os.path.realpath(self.root), str(home))["state"], "complete")

    @unittest.skipUnless(hasattr(os, "getuid"), "the remote side runs on Linux and macOS")
    def test_pasted_picture_lands_in_a_private_temporary_folder_by_absolute_path(self):
        data = b"\x89PNG\r\n\x1a\n" + b"picture" * 60000
        transfer = self.worker.start_image("png", len(data))["id"]
        for offset in range(0, len(data), remote.MAX_READ): self.worker.upload_chunk(transfer, offset, base64.b64encode(data[offset:offset + remote.MAX_READ]).decode())
        saved = Path(self.worker.finish_upload(transfer)["path"])
        self.addCleanup(lambda: saved.exists() and saved.unlink())
        self.assertTrue(saved.is_absolute())
        self.assertEqual(saved.read_bytes(), data)
        self.assertEqual(saved.parent, Path(tempfile.gettempdir()) / f"agentrix-images-{os.getuid()}")
        self.assertEqual(saved.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(saved.parent.glob(".agentrix-upload-*")))
        # Only pictures, and not too large; the project itself is untouched.
        with self.assertRaises(ValueError): self.worker.start_image("sh", 10)
        with self.assertRaises(ValueError): self.worker.start_image("png", 26 * 1024 * 1024)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_old_git_is_named_instead_of_failing_on_its_options(self):
        self.worker._git_version = (1, 8, 3)
        with self.assertRaisesRegex(ValueError, "1.8.3"): self.worker.git("status")
        self.assertEqual(self.worker.no_relative(), [])
        self.worker._git_version = (2, 43, 0)
        self.assertEqual(self.worker.no_relative(), ["--no-relative"])

    def test_rollout_times_are_read_without_fromisoformat(self):
        self.assertEqual(remote.record_time("1970-01-01T00:00:01.5Z"), 1500)
        self.assertEqual(remote.record_time("1970-01-01T08:00:00+08:00"), 0)
        self.assertEqual(remote.record_time("2026-10-12T05:56:02.121Z"), 1791784562121)
        self.assertEqual(remote.record_time("not a time"), 0)
        self.assertEqual(remote.record_time(None), 0)

    def test_file_mutations_and_upload_do_not_overwrite_existing_data(self):
        self.worker.create("", "新目录", "directory")
        self.worker.create("新目录", "first.txt", "file")
        original = self.root / "新目录" / "first.txt"
        original.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError): self.worker.create("新目录", "first.txt", "file")
        self.worker.rename("新目录/first.txt", "renamed.txt")
        self.worker.create("新目录", "exists.txt", "file")
        with self.assertRaises(ValueError): self.worker.rename("新目录/renamed.txt", "exists.txt")
        data = b"upload fixture" * 50000
        transfer = self.worker.start_upload("新目录", "renamed.txt", len(data))["id"]
        for offset in range(0, len(data), remote.MAX_READ): self.worker.upload_chunk(transfer, offset, base64.b64encode(data[offset:offset + remote.MAX_READ]).decode())
        result = self.worker.finish_upload(transfer)
        self.assertEqual((self.root / result["path"]).read_bytes(), data)
        self.assertEqual((self.root / "新目录/renamed.txt").read_text(), "keep")
        canceled = self.worker.start_upload("新目录", "cancel.txt", 9)["id"]
        with self.assertRaises(ValueError): self.worker.finish_upload(canceled)
        self.worker.cancel_upload(canceled)
        self.assertFalse((self.root / "新目录/cancel.txt").exists())
        self.assertFalse(list((self.root / "新目录").glob(".agentrix-upload-*")))
        self.worker.remove(result["path"])
        self.assertFalse((self.root / result["path"]).exists())
        for relative in ("", "../outside", "/outside"):
            with self.assertRaises(ValueError): self.worker.remove(relative)

    def test_deleting_remote_link_preserves_external_target(self):
        if os.name != "posix": self.skipTest("POSIX symlink behavior")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir(); (outside / "keep.txt").write_text("keep")
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.worker.create("link", "escape.txt", "file")
        self.worker.remove("link")
        self.assertEqual((outside / "keep.txt").read_text(), "keep")


    def test_terminals_on_the_host_are_channels_of_one_worker(self):
        import queue
        import threading
        other = Path(self.temp.name) / "other"
        other.mkdir()
        (other / "only-here.txt").write_text("x", encoding="utf-8")
        lines, written, channels = queue.Queue(), [], {}
        send = lambda message: lines.put((json.dumps({"channel": message["channel"], **message}) + "\n").encode())
        def wait(found):
            for _ in range(250):
                match = [message for message in list(written) if found(message)]
                if match: return match[0]
                time.sleep(0.02)
            self.fail("no such message in %r" % written)
        # The shell itself needs a Linux PTY; the channels around it are the same everywhere.
        with mock.patch.object(remote.Worker, "spawn_terminal", lambda *_: None):
            server = threading.Thread(target=remote.serve, args=(lambda _size: lines.get(), written.append, channels), daemon=True)
            server.start()
            bundle = {"key": "a" * 64, "files": [], "instructions": "Read-only references."}
            send({"op": "open", "channel": 1, "path": str(self.root), "token": "one", "projectId": "p", "skillsKey": bundle["key"], "skills": bundle})
            send({"op": "open", "channel": 2, "path": str(other), "token": "two", "projectId": "p", "skillsKey": bundle["key"], "skills": None})
            send({"op": "open", "channel": 3, "path": str(Path(self.temp.name) / "missing"), "token": "three", "projectId": "p"})
            self.assertEqual(wait(lambda m: m["type"] == "ready" and m["channel"] == 1)["info"]["root"], os.path.realpath(self.root))
            self.assertEqual(wait(lambda m: m["type"] == "ready" and m["channel"] == 2)["info"]["root"], os.path.realpath(other))
            self.assertIs(channels[1].worker.skills_bundle, channels[2].worker.skills_bundle)
            self.assertIn("不存在", wait(lambda m: m["type"] == "error" and m.get("channel") == 3)["error"])
            send({"op": "directory", "channel": 2, "id": 7, "path": ""})
            listing = wait(lambda m: m["type"] == "response" and m["id"] == 7)
            self.assertEqual((listing["channel"], [entry["name"] for entry in listing["value"]["entries"]]), (2, ["only-here.txt"]))
            first = channels[1].worker
            send({"op": "shutdown", "channel": 1})
            send({"op": "directory", "channel": 1, "id": 8, "path": ""})
            send({"op": "directory", "channel": 2, "id": 9, "path": ""})
            self.assertEqual(wait(lambda m: m["type"] == "response" and m["id"] == 9)["channel"], 2)
            self.assertTrue(first.stopping)
            self.assertFalse([m for m in written if m.get("id") == 8])
            # A partial oversized open is drained, and malformed opens affect only their named channel.
            second = channels[2].worker
            lines.put(b'{"channel":4,"op":"open","skills":"' + b"x" * remote.MAX_MESSAGE)
            lines.put(b'more data"}\n')
            self.assertIn("过大", wait(lambda m: m["type"] == "error" and m.get("channel") == 4)["error"])
            lines.put(b'{"channel":5,"op":"open",broken}\n')
            wait(lambda m: m["type"] == "error" and m.get("channel") == 5)
            send({"op": "open", "channel": 6, "path": str(self.root), "token": "missing-bundle", "projectId": "p", "skillsKey": "b" * 64})
            self.assertIn("missing", wait(lambda m: m["type"] == "error" and m.get("channel") == 6)["error"])
            lines.put(b'{"channel":[],"op":"open"}\n')
            lines.put(b'[]\n')
            lines.put(b"not a message\n")
            send({"op": "directory", "channel": 2, "id": 10, "path": ""})
            self.assertEqual(wait(lambda m: m["type"] == "response" and m.get("id") == 10)["channel"], 2)
            self.assertFalse(second.stopping)
            self.assertTrue(server.is_alive())
            self.assertTrue(all("channel" in message for message in written))
            lines.put(b"")
            server.join(5)
            self.assertFalse(server.is_alive())
            self.assertTrue(second.stopping)

if __name__ == "__main__": unittest.main()
