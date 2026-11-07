import { describe, expect, it, vi, beforeEach } from "vitest"
import { StarbaseDB } from "./handler"
import type { DataSource } from "./types"
import { executeQuery, executeTransaction } from "./operation"
import { corsPreflight } from "./cors"

vi.mock("./cors", () => ({
    corsPreflight: vi.fn().mockReturnValue(new Response(null, { status: 204 })),
}))

const mockExecutionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

vi.mock("./operation", () => ({
    executeQuery: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
    executeTransaction: vi.fn().mockResolvedValue([[{ id: 1 }]]),
}))

vi.mock("./literest", () => ({
    LiteREST: vi.fn().mockImplementation(() => ({
        handleRequest: vi
            .fn()
            .mockResolvedValue(new Response("mock-rest-response")),
    })),
}))

vi.mock("./plugin", () => ({
    StarbasePluginRegistry: vi.fn().mockImplementation(() => ({
        init: vi.fn(),
    })),
}))

let instance: StarbaseDB
let mockDataSource: DataSource
let mockConfig: any

beforeEach(() => {
    vi.clearAllMocks()
    mockConfig = {
        role: "admin" as "admin" | "client",
        features: { rest: true, export: true, import: true },
    }
    mockDataSource = {
        source: "internal",
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([{ id: 1, name: "Alice" }]),
        } as any,
    }
    instance = new StarbaseDB({
        dataSource: mockDataSource,
        config: mockConfig,
    })
})

describe("StarbaseDB initialization and route handling", () => {
    it("validates external data source requirement and evaluates feature flags", () => {
        expect(instance).toBeDefined()
        expect(instance["getFeature"]("rest")).toBe(true)
        expect(instance["getFeature"]("export")).toBe(true)

        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: "external" } as any,
                    config: mockConfig,
                })
        ).toThrow("No external data sources available.")
    })

    it("handles CORS preflight, status endpoints, and authless pre-auth plugins", async () => {
        const preflightRes = await instance.handle(
            new Request("https://example.com", { method: "OPTIONS" }),
            mockExecutionContext
        )
        expect(corsPreflight).toHaveBeenCalled()
        expect(preflightRes.status).toBe(204)

        const dbStatusRes = await instance.handle(
            new Request("https://example.com/status/database"),
            mockExecutionContext
        )
        expect(dbStatusRes.status).toBe(200)

        const notFoundRes = await instance.handle(
            new Request("https://example.com/non-existent-route"),
            mockExecutionContext
        )
        expect(notFoundRes.status).toBe(404)

        const withPlugin = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [
                {
                    name: "public-ui",
                    pathPrefix: "/studio/*",
                    opts: { requiresAuth: false },
                } as any,
            ],
        })
        const matchedPreAuth = await withPlugin.handlePreAuth(
            new Request("https://example.com/studio/login"),
            mockExecutionContext
        )
        expect(matchedPreAuth).toBeDefined()
    })
})

describe("StarbaseDB queryRoute and cache maintenance", () => {
    it("executes single SQL queries and transactions via queryRoute", async () => {
        const singleRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: JSON.stringify({ sql: "SELECT * FROM users" }),
                headers: { "Content-Type": "application/json" },
            }),
            false
        )
        expect(singleRes.status).toBe(200)
        expect(executeQuery).toHaveBeenCalled()

        const txRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: JSON.stringify({
                    transaction: [{ sql: "INSERT INTO users VALUES (1)" }],
                }),
                headers: { "Content-Type": "application/json" },
            }),
            false
        )
        expect(txRes.status).toBe(200)
        expect(executeTransaction).toHaveBeenCalled()
    })

    it("rejects non-JSON Content-Type, empty SQL, invalid params, and handles errors", async () => {
        const nonJsonRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: "SELECT 1",
                headers: { "Content-Type": "text/plain" },
            }),
            false
        )
        expect(nonJsonRes.status).toBe(400)

        const emptySqlRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: JSON.stringify({ sql: "   " }),
                headers: { "Content-Type": "application/json" },
            }),
            false
        )
        expect(emptySqlRes.status).toBe(400)

        const badParamsRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: JSON.stringify({ sql: "SELECT 1", params: "invalid" }),
                headers: { "Content-Type": "application/json" },
            }),
            false
        )
        expect(badParamsRes.status).toBe(400)

        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {})
        vi.mocked(executeQuery).mockRejectedValueOnce(new Error("DB failure"))
        const errRes = await instance.queryRoute(
            new Request("https://example.com/query", {
                method: "POST",
                body: JSON.stringify({ sql: "SELECT 1" }),
                headers: { "Content-Type": "application/json" },
            }),
            false
        )
        expect(errRes.status).toBe(500)
        consoleSpy.mockRestore()
    })

    it("cleans up expired cache entries via RPC executeQuery", async () => {
        await instance["expireCache"]()
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: "DELETE FROM tmp_cache WHERE timestamp + (ttl * 1000) < ?",
            params: [expect.any(Number)],
        })
    })
})
