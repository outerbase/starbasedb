import os


def test_vitest_coverage_suites_exist_and_cover_edge_cases():
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    rest_test = open(os.path.join(base, "src", "rest", "index.test.ts"), encoding="utf-8").read()
    csv_test = open(os.path.join(base, "src", "export", "csv.test.ts"), encoding="utf-8").read()
    allow_test = open(os.path.join(base, "src", "allowlist", "index.test.ts"), encoding="utf-8").read()

    assert "non_existent_table" in rest_test
    assert "limit: -1" in rest_test
    assert "limit: null" in rest_test
    assert "rowsToCsv" in csv_test
    assert "isTableAllowed" in allow_test
