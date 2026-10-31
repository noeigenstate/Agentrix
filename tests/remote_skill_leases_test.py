import concurrent.futures
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("remote_skill_worker", Path(__file__).resolve().parents[1] / "integration/remote-worker.py")
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteSkillLeasesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentrix-remote-leases-")
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.workers = []
        self.now = time.time()
        self.old = self.now - 31 * 86400

    def tearDown(self):
        for worker in self.workers: worker.stop()
        for filename in self.root.rglob("*"):
            if filename.is_file(): filename.chmod(0o600)
        self.temp.cleanup()

    def worker(self, key):
        worker = remote.Worker(lambda _: None)
        worker.temp = tempfile.mkdtemp(prefix="agentrix-")
        worker.skill_state_dir = str(self.state)
        worker.skills_bundle = {"key": key * 64, "files": [{"id": "builtin:test", "name": "test", "scope": "builtin", "text": "Rules."}],
                                "instructions": "Read {AGENTRIX_SKILLS}/builtin/test/SKILL.md"}
        self.workers.append(worker)
        return worker

    def folder(self, key):
        return self.state / "references" / (key * 64)

    def test_live_other_session_keeps_references_and_pending_proposals_after_bundle_change(self):
        first = self.worker("a")
        first.install_skills("")
        proposal = self.folder("a") / "pending-proposal.md"
        proposal.write_text("Unreviewed proposal.", encoding="utf-8")
        os.utime(self.folder("a"), (self.old, self.old))
        second = self.worker("b")
        second.install_skills("")
        remote.prune_skill_state(str(self.state), "b" * 64, now=self.now)
        self.assertEqual(Path(first.skill_paths["builtin:test"]).read_text(encoding="utf-8"), "Rules.")
        self.assertEqual(proposal.read_text(encoding="utf-8"), "Unreviewed proposal.")
        self.assertIn("Read ", (self.folder("a") / "instructions.md").read_text(encoding="utf-8"))
        env = {"HOME": str(self.root), "USERPROFILE": str(self.root), "AGENTRIX_TOKEN": "fixture", "AGENTRIX_SOCKET": str(self.root / "absent.sock"),
               "AGENTRIX_SKILL_KEY_FILE": str(Path(first.temp) / "skill-key.txt"), "AGENTRIX_SKILL_STATE_DIR": str(self.state / "delivered")}
        for source in ("compact", "clear"):
            output = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", ["notify.py", "claude-hook", "session"]), \
                 mock.patch.object(sys, "stdin", io.StringIO(json.dumps({"session_id": "live-cli", "source": source}))), contextlib.redirect_stdout(output):
                exec(remote.NOTIFY_SOURCE, {})
            self.assertIn(first.skill_paths["builtin:test"], json.loads(output.getvalue())["hookSpecificOutput"]["additionalContext"])

    def test_dead_lease_expires_but_recent_unleased_and_current_keys_survive(self):
        dead = self.worker("a")
        dead.install_skills("")
        leases = list(self.folder("a").glob(".lease-*"))
        self.assertEqual(len(leases), 1)
        for filename in [self.folder("a"), *leases]: os.utime(filename, (self.old, self.old))
        self.folder("b").mkdir()
        self.folder("c").mkdir()
        os.utime(self.folder("c"), (self.old, self.old))
        remote.prune_skill_state(str(self.state), "c" * 64, now=self.now)
        self.assertFalse(self.folder("a").exists())
        self.assertTrue(self.folder("b").exists())
        self.assertTrue(self.folder("c").exists())

    def test_running_worker_renews_every_bundle_lease_and_stop_releases_only_its_own(self):
        first, second = self.worker("a"), self.worker("a")
        for worker in (first, second): worker.install_skills("")
        first.skills_bundle = dict(first.skills_bundle, key="b" * 64)
        first.install_skills("")
        leases = [*self.folder("a").glob(".lease-*"), *self.folder("b").glob(".lease-*")]
        self.assertEqual(len(leases), 3)
        for filename in leases: os.utime(filename, (self.old, self.old))
        with mock.patch.object(remote.time, "monotonic", return_value=1000):
            first.refresh_skill_leases()
        self.assertEqual(sum(filename.stat().st_mtime > self.now - 1 for filename in leases), 2)
        first.stop()
        self.assertEqual(len(list(self.folder("a").glob(".lease-*"))), 1)
        self.assertEqual(list(self.folder("b").glob(".lease-*")), [])
        self.assertGreater(self.folder("b").stat().st_mtime, self.now - 1)
        self.assertTrue((self.folder("b") / "instructions.md").exists())

    def test_concurrent_spawns_and_prunes_keep_both_fresh_installs_and_reused_old_keys(self):
        workers = [self.worker(key) for key in ("a", "b")]
        for worker in workers: worker.install_skills("")
        for key in ("a", "b"):
            for filename in [self.folder(key), *self.folder(key).glob(".lease-*")]: os.utime(filename, (self.old, self.old))
        start = threading.Barrier(2)
        def spawn(worker):
            start.wait(timeout=5)
            for _ in range(5):
                worker.install_skills("")
                remote.prune_skill_state(str(self.state), worker.skills_bundle["key"])
                self.assertEqual(Path(worker.skill_paths["builtin:test"]).read_text(encoding="utf-8"), "Rules.")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(spawn, worker) for worker in workers]
            for future in futures: future.result(timeout=15)
        for key in ("a", "b"): self.assertTrue((self.folder(key) / "instructions.md").exists())

    def test_terminal_loop_renews_leases_and_releases_them_on_normal_exit(self):
        worker = self.worker("a")
        worker.install_skills("")
        import select
        worker.master, worker.child = 100, 200
        try:
            with mock.patch.object(select, "select", return_value=([100], [], [])), mock.patch.object(remote.os, "read", return_value=b""), \
                 mock.patch.object(remote.os, "waitpid", return_value=(200, 0), create=True), \
                 mock.patch.object(remote.os, "WIFEXITED", return_value=True, create=True), \
                 mock.patch.object(remote.os, "WEXITSTATUS", return_value=0, create=True), \
                 mock.patch.object(worker, "refresh_skill_leases", wraps=worker.refresh_skill_leases) as renew:
                worker.terminal_loop()
            renew.assert_called_once_with()
        finally: worker.master = worker.child = None
        self.assertEqual(list(self.folder("a").glob(".lease-*")), [])
        self.assertTrue((self.folder("a") / "instructions.md").exists())

    def test_pruning_waits_for_lease_acquisition_before_removing_a_reused_old_key(self):
        worker = self.worker("a")
        self.folder("a").mkdir(parents=True, mode=0o700)
        os.utime(self.folder("a"), (self.old, self.old))
        acquiring, release, pruning, pruned = (threading.Event() for _ in range(4))
        mkstemp = remote.tempfile.mkstemp
        def acquire(*args, **kwargs):
            if kwargs.get("prefix") == ".lease-":
                acquiring.set()
                self.assertTrue(release.wait(5))
            return mkstemp(*args, **kwargs)
        def prune():
            pruning.set()
            remote.prune_skill_state(str(self.state), "b" * 64)
            pruned.set()
        with mock.patch.object(remote.tempfile, "mkstemp", side_effect=acquire), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            installing = pool.submit(worker.install_skills, "")
            self.assertTrue(acquiring.wait(5))
            cleaning = pool.submit(prune)
            try:
                self.assertTrue(pruning.wait(5))
                self.assertFalse(pruned.wait(0.1), "a prune must not pass a lease installation in progress")
            finally: release.set()
            installing.result(timeout=5)
            cleaning.result(timeout=5)
        self.assertEqual(Path(worker.skill_paths["builtin:test"]).read_text(encoding="utf-8"), "Rules.")

    @unittest.skipUnless(os.name == "posix", "Remote SSH processes run on Linux")
    def test_separate_ssh_process_cannot_prune_during_an_install(self):
        script = '''import importlib.util,sys
spec=importlib.util.spec_from_file_location("remote_worker",sys.argv[1])
remote=importlib.util.module_from_spec(spec);spec.loader.exec_module(remote)
import fcntl
flock=fcntl.flock
def observed(fd, mode):
    print("locking",flush=True)
    flock(fd,mode)
fcntl.flock=observed
remote.prune_skill_state(sys.argv[2],"b"*64)
print("pruned",flush=True)
'''
        with remote.skill_state_lock(str(self.state)):
            child = subprocess.Popen([sys.executable, "-B", "-c", script, remote.__file__, str(self.state)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.poll() is None and child.kill())
            self.assertEqual(child.stdout.readline().strip(), "locking")
            with self.assertRaises(subprocess.TimeoutExpired): child.wait(timeout=0.1)
        stdout, stderr = child.communicate(timeout=5)
        self.assertEqual((child.returncode, stdout.strip(), stderr), (0, "pruned", ""))


if __name__ == "__main__": unittest.main()
