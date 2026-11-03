"""Trusted pytest observer. Evidence leaves over this invocation's stdout, never a workspace file."""
import json
import inspect
import os
import sys

sys.dont_write_bytecode = True
for key in list(os.environ):
    if key.startswith("PYTEST_"):
        del os.environ[key]
os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
nonce = sys.argv.pop(1)

import pytest


class Evidence:
    def __init__(self):
        self.events = []
        self.collection_errors = []
        self.plugins = set()

    @pytest.hookimpl(trylast=True)
    def pytest_configure(self, config):
        self.record_plugins(config)

    def pytest_sessionfinish(self, session):
        self.record_plugins(session.config)

    def record_plugins(self, config):
        root = os.path.realpath(os.getcwd())
        for plugin in config.pluginmanager.get_plugins():
            filename = getattr(inspect.getmodule(plugin), "__file__", None)
            if not filename:
                continue
            filename = os.path.realpath(filename)
            try:
                if os.path.commonpath([root, filename]) == root:
                    self.plugins.add(os.path.relpath(filename, root).replace(os.sep, "/"))
            except ValueError:
                pass  # A runtime or installed dependency can be on another Windows volume.

    def pytest_runtest_logreport(self, report):
        self.events.append([report.nodeid, report.when, report.outcome, hasattr(report, "wasxfail")])

    def pytest_collectreport(self, report):
        if not report.passed:
            self.collection_errors.append(report.nodeid)


evidence = Evidence()
code = int(pytest.main(sys.argv[1:], plugins=[evidence]))
payload = {"version": 1, "code": code, "events": evidence.events, "collectionErrors": evidence.collection_errors,
           "plugins": sorted(evidence.plugins)}
print("\nAGENTRIX_OSS_EVIDENCE_" + nonce + "=" + json.dumps(payload, separators=(",", ":")), flush=True)
raise SystemExit(code)
