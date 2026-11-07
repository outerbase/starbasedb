import { describe, it, expect, vi, beforeEach } from "vitest"
import { isQueryAllowed } from "./index"
import type { DataSource } from "../types"
import type { StarbaseDBConfiguration } from "../handler"

// Builds a mock DataSource backed by an in-memory RPC query spy for allowlist inspection.
function createMockDataSource(rows: Record<string, unknown>[] = []): DataSource {
    return {
        source: "internal",
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(rows),
        } as unknown as DataSource["rpc"],
    }
}

// Builds a StarbaseDBConfiguration for role-based allowlist bypass and enforcement checks.
function createConfig(
    role: "admin" | "client" = "client",
    allowlist = true
): StarbaseDBConfiguration {
    return {
        role,
        features: { allowlist },
    }
}

describe("isQueryAllowed bypass and AST evaluation", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("bypasses storage lookup when allowlist is disabled or role is admin", async () => {
        const dataSource = createMockDataSource()
        const disabledResult = await isQueryAllowed({
            sql: "DROP TABLE users",
            isEnabled: false,
            dataSource,
            config: createConfig("client", false),
        })
        const adminResult = await isQueryAllowed({
            sql: "DELETE FROM users",
            isEnabled: true,
            dataSource,
            config: createConfig("admin", true),
        })

        expect(disabledResult).toBe(true)
        expect(adminResult).toBe(true)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it("returns an Error when SQL is empty and matches normalized AST queries with semicolons", async () => {
        const dataSource = createMockDataSource([
            {
                sql_statement: "SELECT id, name FROM users WHERE id = 1;",
                source: "internal",
            },
            {
                sql_statement: "SELECT * FROM ignored_other_source",
                source: "external",
            },
        ])

        const emptyResult = await isQueryAllowed({
            sql: "",
            isEnabled: true,
            dataSource,
            config: createConfig("client", true),
        })
        expect(emptyResult).toBeInstanceOf(Error)

        const matchedResult = await isQueryAllowed({
            sql: "SELECT id, name FROM users WHERE id = 1",
            isEnabled: true,
            dataSource,
            config: createConfig("client", true),
        })
        expect(matchedResult).toBe(true)
    })

    it("records non-matching queries in tmp_allowlist_rejections and handles RPC errors", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {})
        const dataSource = createMockDataSource([
            { sql_statement: "SELECT id FROM users", source: "internal" },
        ])

        await expect(
            isQueryAllowed({
                sql: "SELECT email FROM users",
                isEnabled: true,
                dataSource,
                config: createConfig("client", true),
            })
        ).rejects.toThrow("Query not allowed")

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: "INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)",
            params: ["SELECT email FROM users", "internal"],
        })

        vi.mocked(dataSource.rpc.executeQuery).mockRejectedValue(
            new Error("RPC storage offline")
        )
        await expect(
            isQueryAllowed({
                sql: "SELECT 1",
                isEnabled: true,
                dataSource,
                config: createConfig("client", true),
            })
        ).rejects.toThrow("Query not allowed")

        expect(consoleSpy).toHaveBeenCalled()
        consoleSpy.mockRestore()
    })
})
