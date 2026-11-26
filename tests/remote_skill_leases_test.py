import concurrent.futures
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("remote_guide_worker", Path(__file__).resolve().parents[1] / "integration/remote-worker.py")
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RemoteGuideLeasesTest(unittest.TestCase):
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
        worker.guide_state_dir = str(self.state)
        worker.guide = {"key": key * 64, "text": "Rules for " + key + "."}
        self.workers.append(worker)
        return worker

    def folder(self, key):
        return self.state / (key * 64)

    def test_another_channels_live_lease_keeps_an_old_guide_during_pruning(self):
        first = self.worker("a")
        old_path = Path(first.install_guide(first.guide))
        os.utime(old_path.parent, (self.old, self.old))
        second = self.worker("b")
        new_path = Path(second.install_guide(second.guide))
        remote.prune_guide_state(str(self.state), now=self.now)
        self.assertEqual(old_path.read_text(encoding="utf-8"), first.guide["text"])
        self.assertEqual(new_path.read_text(encoding="utf-8"), second.guide["text"])

    def test_expired_guide_with_a_dead_lease_is_removed_and_recent_guide_is_kept(self):
        dead = self.worker("a")
        dead.install_guide(dead.guide)
        leases = list(self.folder("a").glob(".lease-*"))
        self.assertEqual(len(leases), 1)
        for filename in [self.folder("a"), *leases]: os.utime(filename, (self.old, self.old))
        recent = self.worker("b")
        recent_path = Path(recent.install_guide(recent.guide))
        recent.stop()
        remote.prune_guide_state(str(self.state), now=self.now)
        self.assertFalse(self.folder("a").exists())
        self.assertTrue(recent_path.is_file())

    def test_running_worker_renews_every_guide_lease_and_stop_releases_only_its_own(self):
        first, second = self.worker("a"), self.worker("a")
        for worker in (first, second): worker.install_guide(worker.guide)
        first.guide = dict(first.guide, key="b" * 64)
        first.install_guide(first.guide)
        leases = [*self.folder("a").glob(".lease-*"), *self.folder("b").glob(".lease-*")]
        self.assertEqual(len(leases), 3)
        for filename in leases: os.utime(filename, (self.old, self.old))
        os.utime(self.folder("b"), (self.old, self.old))
        with mock.patch.object(remote.time, "monotonic", return_value=1000):
            first.refresh_reference_leases()
        self.assertEqual(sum(filename.stat().st_mtime > self.now - 1 for filename in leases), 2)
        self.assertGreater(self.folder("b").stat().st_mtime, self.now - 1)
        os.utime(self.folder("b"), (self.old, self.old))
        first.stop()
        self.assertEqual(len(list(self.folder("a").glob(".lease-*"))), 1)
        self.assertEqual(list(self.folder("b").glob(".lease-*")), [])
        self.assertGreater(self.folder("b").stat().st_mtime, self.now - 1)
        self.assertTrue((self.folder("b") / "model-routing.md").exists())

    def test_concurrent_spawns_and_prunes_keep_both_fresh_installs_and_reused_old_keys(self):
        workers = [self.worker(key) for key in ("a", "b")]
        for worker in workers: worker.install_guide(worker.guide)
        for key in ("a", "b"):
            for filename in [self.folder(key), *self.folder(key).glob(".lease-*")]: os.utime(filename, (self.old, self.old))
        start = threading.Barrier(2)
        def spawn(worker):
            start.wait(timeout=5)
            for _ in range(5):
                filename = worker.install_guide(worker.guide)
                remote.prune_guide_state(str(self.state))
                self.assertEqual(Path(filename).read_text(encoding="utf-8"), worker.guide["text"])
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(spawn, worker) for worker in workers]
            for future in futures: future.result(timeout=15)
        for key in ("a", "b"): self.assertTrue((self.folder(key) / "model-routing.md").exists())

    def test_terminal_loop_renews_leases_and_releases_them_on_normal_exit(self):
        worker = self.worker("a")
        worker.install_guide(worker.guide)
        import select
        worker.master, worker.child = 100, 200
        try:
            with mock.patch.object(select, "select", return_value=([100], [], [])), mock.patch.object(remote.os, "read", return_value=b""), \
                 mock.patch.object(remote.os, "waitpid", return_value=(200, 0), create=True), \
                 mock.patch.object(remote.os, "WIFEXITED", return_value=True, create=True), \
                 mock.patch.object(remote.os, "WEXITSTATUS", return_value=0, create=True), \
                 mock.patch.object(worker, "refresh_reference_leases", wraps=worker.refresh_reference_leases) as renew:
                worker.terminal_loop()
            renew.assert_called_once_with()
        finally: worker.master = worker.child = None
        self.assertEqual(list(self.folder("a").glob(".lease-*")), [])
        self.assertTrue((self.folder("a") / "model-routing.md").exists())

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
            remote.prune_guide_state(str(self.state))
            pruned.set()
        with mock.patch.object(remote.tempfile, "mkstemp", side_effect=acquire), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            installing = pool.submit(worker.install_guide, worker.guide)
            self.assertTrue(acquiring.wait(5))
            cleaning = pool.submit(prune)
            try:
                self.assertTrue(pruning.wait(5))
                self.assertFalse(pruned.wait(0.1), "a prune must not pass a lease installation in progress")
            finally: release.set()
            filename = installing.result(timeout=5)
            cleaning.result(timeout=5)
        self.assertEqual(Path(filename).read_text(encoding="utf-8"), worker.guide["text"])

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
remote.prune_guide_state(sys.argv[2])
print("pruned",flush=True)
'''
        with remote.reference_state_lock(str(self.state)):
            child = subprocess.Popen([sys.executable, "-B", "-c", script, remote.__file__, str(self.state)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.poll() is None and child.kill())
            self.assertEqual(child.stdout.readline().strip(), "locking")
            with self.assertRaises(subprocess.TimeoutExpired): child.wait(timeout=0.1)
        stdout, stderr = child.communicate(timeout=5)
        self.assertEqual((child.returncode, stdout.strip(), stderr), (0, "pruned", ""))


if __name__ == "__main__": unittest.main()
