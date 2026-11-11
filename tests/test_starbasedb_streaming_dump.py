import os


def test_starbasedb_streaming_dump_implementation():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    dump_ts = open(os.path.join(base, "src", "export", "dump.ts"), encoding="utf-8").read()
    assert "ReadableStream" in dump_ts
    assert "LIMIT ${batchSize} OFFSET ${offset}" in dump_ts
    assert "cooperativeBreathingPause" in dump_ts
    assert "r2Bucket" in dump_ts
    assert "BEGIN TRANSACTION;" in dump_ts
    assert "COMMIT;" in dump_ts


def test_sql_escaping_and_pagination_test_file_present():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    dump_test = open(os.path.join(base, "src", "export", "dump.test.ts"), encoding="utf-8").read()
    assert "batchSize: 500" in dump_test
    assert "breathingIntervalMs: 1" in dump_test
    assert "row_1200_O''Reilly" in dump_test
