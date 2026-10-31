import contextlib
import concurrent.futures
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error

MODULE_PATH = Path(__file__).resolve().parents[1] / "integration" / "remote-worker.py"
spec = importlib.util.spec_from_file_location("remote_claude_worker", MODULE_PATH)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteClaudeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentrix-remote-claude-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.config = self.home / ".claude"
        self.config.mkdir()
        self.project = self.home / "project"
        self.project.mkdir()
        self.route = {"home": str(self.home), "configDir": None, "secureDir": None, "overridden": False}
        self.now = 1793400000000
        self.credential = self.config / ".credentials.json"
        self.write_credentials()
        self.requests = []
        self.body = {"five_hour": {"utilization": 42.5, "resets_at": "2026-10-31T12:00:00Z"}, "seven_day": {"utilization": 9, "resets_at": None}, "private": "fake-secret"}

    def write_credentials(self, **changes):
        value = {"accessToken": "fake-secret-access-token", "expiresAt": self.now + 1000000, "scopes": ["user:inference", "user:profile"], **changes}
        self.credential.write_text(json.dumps({"claudeAiOauth": value, "refreshToken": "fake-secret-refresh-token"}), encoding="utf-8")
        self.credential_revision = getattr(self, "credential_revision", 0) + 1
        stamp = 1700000000 + self.credential_revision
        os.utime(self.credential, (stamp, stamp))

    def open_url(self, request, timeout):
        self.requests.append((request, timeout))
        return io.BytesIO(json.dumps(self.body).encode())

    def read(self, **kwargs):
        return remote.query_claude_account(self.route, self.now, open_url=kwargs.get("open_url", self.open_url))

    def test_read_only_get_keeps_credentials_on_the_remote_host_and_returns_only_numbers(self):
        before = self.credential.read_bytes()
        result = self.read()
        request, timeout = self.requests[0]
        self.assertEqual((request.full_url, request.method, timeout), ("https://api.anthropic.com/api/oauth/usage", "GET", 5))
        self.assertEqual(request.get_header("Authorization"), "Bearer fake-secret-access-token")
        self.assertIsNone(request.data)
        self.assertEqual(result, {"state": "ready", "account": {"at": self.now, "source": "Claude", "limits": [
            {"minutes": 300, "percent": 42.5, "resetsAt": remote.record_time("2026-10-31T12:00:00Z")},
            {"minutes": 10080, "percent": 9, "resetsAt": None}]}})
        self.assertEqual(self.credential.read_bytes(), before)
        self.assertNotIn("secret", json.dumps(result))
        self.write_credentials(accessToken="fake-second-token")
        self.assertEqual(self.read()["state"], "ready")
        self.assertEqual(self.requests[-1][0].get_header("Authorization"), "Bearer fake-second-token")

    def test_missing_expired_malformed_and_wrong_scope_credentials_never_fetch_or_refresh(self):
        for changes, reason in (({"accessToken": ""}, "credentials"), ({"accessToken": "fake\nsecret"}, "credentials"),
                                ({"scopes": ["user:profile"]}, "scope"), ({"scopes": "user:inference,user:profile"}, "scope"),
                                ({"expiresAt": self.now}, "expired"), ({"expiresAt": True}, "expired")):
            self.write_credentials(**changes)
            self.assertEqual(self.read(), {"state": "skipped", "reason": reason})
        self.credential.unlink()
        self.assertEqual(self.read()["reason"], "credentials")
        self.credential.write_text("fake-secret-not-json", encoding="utf-8")
        self.assertEqual(self.read(), {"state": "error", "reason": "query"})
        self.assertEqual(self.requests, [])

    def test_declared_config_and_secure_storage_are_used_without_falling_back_to_another_account(self):
        custom, secure = self.home / "custom", self.home / "secure"
        custom.mkdir(); secure.mkdir()
        self.route["configDir"] = str(custom)
        self.assertEqual(self.read()["reason"], "credentials")
        self.credential = custom / ".credentials.json"
        self.write_credentials(accessToken="custom-fake-token")
        self.assertEqual(self.read()["state"], "ready")
        self.route["secureDir"] = str(secure)
        self.assertEqual(self.read()["reason"], "credentials")
        self.credential = secure / ".credentials.json"
        self.write_credentials(accessToken="secure-fake-token")
        self.assertEqual(self.read()["state"], "ready")
        self.assertEqual([request.get_header("Authorization") for request, _ in self.requests], ["Bearer custom-fake-token", "Bearer secure-fake-token"])

    def test_official_route_checks_every_project_before_sharing_host_limits(self):
        calls = []
        accounts = remote.RemoteClaudeAccounts(now=lambda: self.now, query=lambda route, now: calls.append(route) or self.read())
        self.assertEqual(accounts.read(self.route, str(self.project))["state"], "ready")
        self.assertEqual(accounts.read(self.route, str(self.project))["state"], "ready")
        self.assertEqual(len(calls), 1)
        for revision, setting in enumerate(({"env": {"ANTHROPIC_BASE_URL": "https://fake-secret.invalid"}}, {"apiKeyHelper": "fake-secret-command"}, {"forceLoginMethod": "console"})):
            (self.config / "settings.json").write_text(json.dumps(setting), encoding="utf-8")
            os.utime(self.config / "settings.json", (1700000000 + revision, 1700000000 + revision))
            self.assertEqual(accounts.read(self.route, str(self.project)), {"state": "skipped", "reason": "route"})
        (self.config / "settings.json").unlink()
        folder = self.project / ".claude"
        folder.mkdir()
        (folder / "settings.local.json").write_text('{"env":{"anthropic_api_key":"fake-secret"}}', encoding="utf-8")
        self.assertEqual(accounts.read(self.route, str(self.project))["reason"], "route")
        self.assertEqual(accounts.read(dict(self.route, overridden=True), None)["reason"], "route")
        for name in ("home", "configDir", "secureDir"):
            self.assertEqual(accounts.read(dict(self.route, **{name: "relative"}), None)["reason"], "route")
        self.assertEqual(accounts.read(None, None)["reason"], "route")
        self.assertEqual(len(calls), 1)

    def test_invalid_and_partial_numbers_preserve_unknown_and_valid_zero(self):
        for value in (True, "9", -1, float("nan"), float("inf"), None):
            self.body = {"five_hour": {"utilization": value}, "seven_day": {"utilization": 0, "resets_at": "invalid"}}
            self.assertEqual(self.read()["account"]["limits"], [{"minutes": 10080, "percent": 0, "resetsAt": None}])
        self.body = {"five_hour": None, "seven_day": {"utilization": True}}
        self.assertEqual(self.read(), {"state": "error", "reason": "response"})

    def test_http_errors_timeouts_and_private_diagnostics_are_sanitized_and_never_read(self):
        for status in (302, 401, 429, 503):
            body = mock.MagicMock()
            body.read.side_effect = AssertionError("must not read a private error body")
            error = urllib.error.HTTPError("https://fake-secret.invalid", status, "fake-secret-token", {"Retry-After": "120"}, body)
            def fail(*_args, **_kwargs): raise error
            result = self.read(open_url=fail)
            self.assertEqual((result["state"], result["status"], result["retryAfterMs"]), ("error", status, 120000 if status in (429, 503) else 0))
            self.assertNotIn("secret", json.dumps(result)); body.read.assert_not_called()
        for error in (OSError("fake-secret-token"), ValueError("fake-secret-token"), socket.timeout("fake-secret-token")):
            def fail(*_args, **_kwargs): raise error
            result = self.read(open_url=fail)
            self.assertEqual(result["state"], "error")
            self.assertNotIn("secret", json.dumps(result))
        with mock.patch.object(remote.urllib.request, "build_opener") as build:
            build.return_value.open = self.open_url
            self.assertEqual(remote.query_claude_account(self.route, self.now)["state"], "ready")
            handler = build.call_args[0][0]
            self.assertIsInstance(handler, remote.NoAccountRedirect)
            self.assertIsNone(handler.redirect_request(None, None, 302, None, None, "https://outside.invalid"))

    def test_shared_host_reads_serialize_throttle_and_back_off_without_caching_tokens(self):
        started, release = threading.Event(), threading.Event()
        calls, results = [], []
        def query(route, now):
            calls.append(route)
            started.set(); self.assertTrue(release.wait(5))
            return {"state": "ready", "account": {"at": now, "source": "Claude", "limits": [{"minutes": 300, "percent": 7, "resetsAt": None}]}}
        accounts = remote.RemoteClaudeAccounts(now=lambda: self.now, query=query)
        threads = [threading.Thread(target=lambda: results.append(accounts.read(self.route, str(self.project)))) for _ in range(2)]
        for thread in threads: thread.start()
        self.assertTrue(started.wait(5)); release.set()
        for thread in threads: thread.join(5); self.assertFalse(thread.is_alive())
        self.assertEqual(len(calls), 1); self.assertEqual(results[0], results[1])
        self.assertNotIn("token", repr(accounts.results))
        self.now += 60000
        accounts.query = lambda *_: {"state": "error", "reason": "http", "status": 429, "retryAfterMs": 180000}
        self.assertEqual(accounts.read(self.route, str(self.project))["status"], 429)
        self.now += 120000
        accounts.query = lambda *_: self.fail("Retry-After must throttle host reads")
        self.assertEqual(accounts.read(self.route, str(self.project))["status"], 429)

    def test_retry_after_seconds_dates_and_malformed_headers_are_bounded(self):
        self.assertEqual(remote.account_retry_after("120", self.now), 120000)
        self.assertEqual(remote.account_retry_after(" 0.5 ", self.now), 500)
        self.assertEqual(remote.account_retry_after("999999", self.now), 900000)
        date = "Sat, 31 Oct 2026 12:00:00 GMT"
        at = remote.record_time("2026-10-31T12:00:00Z")
        self.assertEqual(remote.account_retry_after(date, at - 120000), 120000)
        self.assertEqual(remote.account_retry_after(date, at + 1), 0)
        for value in (None, {}, "", "fake-secret-diagnostic", "inf", "9" * 2000):
            self.assertEqual(remote.account_retry_after(value, self.now), 0)

    def test_channel_account_reply_never_contains_routes_credentials_or_query_errors(self):
        messages = []
        channel = remote.Channel(1, messages.append)
        self.addCleanup(channel.close)
        channel.worker.coding_root = str(self.project)
        channel.worker.claude_route = self.route
        channel.worker.claude_accounts = remote.RemoteClaudeAccounts(now=lambda: self.now, query=lambda *_: self.read())
        channel.dispatch({"op": "claude-account", "id": 2})
        reply = messages.pop()
        self.assertEqual((reply["type"], reply["channel"], reply["id"], reply["value"]["state"]), ("response", 1, 2, "ready"))
        for text in ("secret", str(self.home), "credentials", "Authorization"):
            self.assertNotIn(text, json.dumps(reply))
        channel.worker.stop()
        self.assertEqual(channel.worker.claude_account()["reason"], "cancelled")

    def hook(self, source="startup", session="session-one", **env_changes):
        client = mock.MagicMock(); client.__enter__.return_value = client
        env = {"HOME": str(self.home), "USERPROFILE": str(self.home), "AGENTRIX_TOKEN": "fixture-envelope", "AGENTRIX_SOCKET": "fixture.sock",
               "AGENTRIX_READING_NOTE_FILE": str(self.home / "note.txt"), "AGENTRIX_SKILL_KEY_FILE": str(self.home / "key.txt"),
               "AGENTRIX_SKILL_STATE_DIR": str(self.home / "delivery"), **env_changes}
        output = io.StringIO()
        payload = {"session_id": session, "source": source, "transcript_path": str(self.config / "projects" / "session.jsonl")}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", ["notify.py", "claude-hook", "session"]), \
             mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), mock.patch("socket.AF_UNIX", 1, create=True), \
             mock.patch("socket.socket", return_value=client), contextlib.redirect_stdout(output):
            exec(remote.NOTIFY_SOURCE, {})
        return (json.loads(output.getvalue()) if output.getvalue() else None), json.loads(client.sendall.call_args[0][0])

    def test_session_start_delivers_once_per_cli_identity_and_fingerprint_but_after_every_compact_and_clear(self):
        (self.home / "note.txt").write_text("You run inside Agentrix. Startup instructions. Agentrix skill delivery: remote. System skills: read the enabled manifest.", encoding="utf-8")
        for key in ("a" * 64, "b" * 64):
            manifest = self.home / "references" / key / "instructions.md"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("System skills: read the enabled manifest.", encoding="utf-8")
        (self.home / "key.txt").write_text("a" * 64, encoding="utf-8")
        os.utime(self.home / "key.txt", (1700000000, 1700000000))
        first, event = self.hook()
        self.assertEqual(first["hookSpecificOutput"], {"hookEventName": "SessionStart", "additionalContext": "Agentrix skill instructions:\nSystem skills: read the enabled manifest."})
        self.assertEqual(event["state"], "session")
        for source in ("startup", "resume"): self.assertIsNone(self.hook(source)[0])
        for source in ("compact", "compact", "clear", "clear"): self.assertIsNotNone(self.hook(source)[0])
        self.assertIsNotNone(self.hook(session="session-two")[0])
        (self.home / "key.txt").write_text("b" * 64, encoding="utf-8")
        os.utime(self.home / "key.txt", (1700000001, 1700000001))
        self.assertIsNotNone(self.hook("resume")[0])
        self.assertIsNone(self.hook("resume")[0])
        self.assertIsNone(self.hook("unknown")[0])
        self.assertIsNone(self.hook(session="../../escape")[0])
        self.assertEqual(len([file for file in (self.home / "delivery").rglob("*") if file.is_file()]), 3)

    def test_shared_receipt_lifecycle_fixture_matches_python_and_every_remaining_receipt(self):
        fixture = json.loads((MODULE_PATH.parents[1] / "tests/fixtures/skill-receipts/lifecycle.json").read_text(encoding="utf-8"))
        for key in fixture["manifests"].values():
            manifest = self.home / "references" / key / "instructions.md"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("Shared instructions.", encoding="utf-8")
        for revision, step in enumerate(fixture["steps"]):
            (self.home / "key.txt").write_text(fixture["manifests"][step["key"]], encoding="utf-8")
            os.utime(self.home / "key.txt", (1700000000 + revision, 1700000000 + revision))
            result, _ = self.hook(step["source"], step["session"])
            self.assertEqual(result is not None, step["deliver"], step)
            if result: self.assertEqual(result["hookSpecificOutput"]["additionalContext"], "Agentrix skill instructions:\nShared instructions.")
            expected = []
            for value in step["receipts"]:
                session, key = value.split("/")
                expected.append("claude/" + hashlib.sha256(session.encode()).hexdigest()[:32] + "/" + fixture["manifests"][key][:32])
            folder = self.home / "delivery"
            actual = sorted(file.relative_to(folder).as_posix() for file in folder.rglob("*") if file.is_file())
            self.assertEqual(actual, sorted(expected), step)

    def test_spawn_pruning_removes_expired_unleased_reference_keys_and_receipts(self):
        state = self.home / "pruned-state"
        current, stale = "c" * 64, "d" * 64
        for key in (current, stale):
            folder = state / "references" / key / "builtin/test"
            folder.mkdir(parents=True)
            remote.write_skill_reference(str(folder / "SKILL.md"), "Rules.")
        now = time.time()
        old = now - 31 * 86400
        for key in (current, stale): os.utime(state / "references" / key, (old, old))
        recent = state / "delivered/claude" / ("a" * 32) / ("b" * 32)
        expired = state / "delivered/claude" / ("a" * 32) / ("c" * 32)
        legacy = state / "delivered" / ("e" * 64)
        for filename, age in ((recent, 29), (expired, 31), (legacy, 31)):
            filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            filename.write_text("", encoding="utf-8")
            os.utime(filename, (now - age * 86400, now - age * 86400))
        remote.prune_skill_state(str(state), current, now=now)
        self.assertFalse((state / "references" / stale).exists())
        self.assertEqual((state / "references" / current / "builtin/test/SKILL.md").read_text(encoding="utf-8"), "Rules.")
        self.assertTrue(recent.exists())
        self.assertFalse(expired.exists()); self.assertFalse(legacy.exists())
        (state / "references" / current / "builtin/test/SKILL.md").chmod(0o600)

    def test_hooks_register_only_remote_paths_and_override_presence_never_credential_values(self):
        _, event = self.hook(ANTHROPIC_AUTH_TOKEN="fake-secret-token", CLAUDE_CONFIG_DIR=str(self.config))
        self.assertTrue(event["accountRoute"]["overridden"])
        self.assertEqual(event["accountRoute"]["configDir"], str(self.config))
        self.assertNotIn("fake-secret-token", json.dumps(event))
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", json.dumps(event))
        # The full skills body is emitted only by SessionStart, not repeated in CLI startup arguments.
        wrapper = remote.BASH_SOURCE.split("function claude {", 1)[1].split("__pg_prompt()", 1)[0]
        self.assertIn('note=(--append-system-prompt "$current_note")', wrapper)
        self.assertIn('current_note%%" Agentrix skill delivery: "*', wrapper)
        self.assertIn("Agentrix delivers skill instructions through its SessionStart hook.", wrapper)

    def test_auto_skill_reference_paths_survive_a_closed_terminal_and_are_reused_on_resume(self):
        bundle = {"key": "c" * 64, "files": [{"id": "builtin:test", "name": "test", "scope": "builtin", "text": "---\nname: test\ndescription: Test.\n---\nRules."}],
                  "instructions": "Read {AGENTRIX_SKILLS}/builtin/test/SKILL.md."}
        state_dir = str(self.home / "worker-state")
        paths = []
        for _ in range(2):
            worker = remote.Worker(lambda _: None)
            worker.temp = tempfile.mkdtemp(prefix="agentrix-")
            worker.skill_state_dir, worker.skills_bundle = state_dir, bundle
            try:
                note = worker.install_skills(bundle["instructions"])
                paths.append(worker.skill_paths["builtin:test"])
                self.assertIn(paths[-1], note)
            finally: worker.stop()
            self.assertFalse(Path(worker.temp).exists())
            self.assertEqual(Path(paths[-1]).read_text(encoding="utf-8"), bundle["files"][0]["text"])
        self.assertEqual(paths[0], paths[1])
        Path(paths[0]).chmod(0o600)

    def test_parallel_channels_install_the_same_read_only_skill_references_atomically(self):
        state_dir = str(self.home / "concurrent-worker-state")
        bundle = {"key": "d" * 64, "files": [{"id": "builtin:test", "name": "test", "scope": "builtin", "text": "Shared rules.\n" * 300}],
                  "instructions": "Read {AGENTRIX_SKILLS}/builtin/test/SKILL.md."}
        barrier = threading.Barrier(6)
        def install():
            worker = remote.Worker(lambda _: None)
            worker.temp = tempfile.mkdtemp(prefix="agentrix-")
            worker.skill_state_dir, worker.skills_bundle = state_dir, bundle
            try:
                barrier.wait(timeout=5)
                worker.install_skills(bundle["instructions"])
                return worker.skill_paths["builtin:test"]
            finally: worker.stop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = [future.result(timeout=10) for future in [pool.submit(install) for _ in range(6)]]
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(Path(results[0]).read_text(encoding="utf-8"), bundle["files"][0]["text"])
        self.assertFalse(list(Path(state_dir).rglob(".skill-*")))
        for filename in Path(state_dir).rglob("*"):
            if filename.is_file(): filename.chmod(0o600)

    def test_authenticated_hooks_bind_the_actual_remote_claude_home_and_strip_routes_before_ssh(self):
        _, event = self.hook(CLAUDE_CONFIG_DIR=str(self.config), ANTHROPIC_AUTH_TOKEN="fake-secret-token")
        events = []
        worker = remote.Worker(events.append)
        worker.initialize({"path": str(self.project), "token": "fixture-envelope", "projectId": "fixture-project"})
        self.addCleanup(worker.stop)
        client = mock.MagicMock(); client.__enter__.return_value = client
        client.recv.return_value = json.dumps(event).encode() + b"\n"
        worker.listener = mock.MagicMock()
        worker.listener.accept.side_effect = [(client, None), OSError("closed")]
        worker.events_loop()
        self.assertEqual(worker.claude_home, str(self.config))
        self.assertTrue(worker.claude_route["overridden"])
        self.assertEqual(events[0]["event"]["state"], "session")
        self.assertNotIn("accountRoute", events[0]["event"])
        self.assertNotIn("secret", json.dumps(events))
        filename = self.config / "projects" / "fixture-project" / "session.jsonl"
        filename.parent.mkdir(parents=True)
        filename.write_text(json.dumps({"type": "user", "parentUuid": None, "message": {"content": "Choose the next step"}}) + "\n", encoding="utf-8")
        self.assertTrue(worker.claude_status(str(filename), 1000)["records"])


if __name__ == "__main__": unittest.main()
