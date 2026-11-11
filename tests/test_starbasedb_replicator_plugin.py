import json
import os


def test_replicator_plugin_structure_and_watermark_sync():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    code = open(os.path.join(base, "plugins", "replicator", "index.ts"), encoding="utf-8").read()
    assert "class ExternalReplicationPlugin" in code
    assert "CREATE TABLE IF NOT EXISTS" in code
    assert "INSERT OR REPLACE INTO" in code
    assert "watermarkColumn" in code


def test_replicator_meta_json_valid():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    meta = json.load(open(os.path.join(base, "plugins", "replicator", "meta.json"), encoding="utf-8"))
    assert meta["id"] == "starbasedb:external-replicator"


def test_replicator_vitest_suite_present():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    test_ts = open(os.path.join(base, "plugins", "replicator", "index.test.ts"), encoding="utf-8").read()
    assert "plugin.syncAll()" in test_ts
