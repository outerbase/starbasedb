import { describe, it, expect, vi, beforeEach } from "vitest"
import {
    executeQuery,
    executeTransaction,
    executeExternalQuery,
    executeSDKQuery,
} from "./operation"
import { isQueryAllowed } from "./allowlist"
import { applyRLS } from "./rls"
import { beforeQueryCache, afterQueryCache } from "./cache"
import type { DataSource } from "./types"
import type { StarbaseDBConfiguration } from "./handler"

const mockSdkClient = vi.hoisted(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    raw: vi
        .fn()
        .mockResolvedValue({ data: [{ id: 1, name: "SDK-Test-Result" }] }),
}))

const mockPgUnsafe = vi.hoisted(() => ({
    unsafe: vi.fn().mockResolvedValue([{ id: 10, name: "Hyperdrive-Row" }]),
    end: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("pg", () => ({ Client: vi.fn() }))
vi.mock("mysql2", () => ({ createConnection: vi.fn() }))
vi.mock("@libsql/client/web", () => ({ createClient: vi.fn() }))
vi.mock("postgres", () => ({
    default: vi.fn(() => mockPgUnsafe),
}))

vi.mock("@outerbase/sdk", () => ({
    PostgreSQLConnection: vi.fn(() => mockSdkClient),
    MySQLConnection: vi.fn(() => mockSdkClient),
    CloudflareD1Connection: vi.fn(() => mockSdkClient),
    StarbaseConnection: vi.fn(() => mockSdkClient),
    TursoConnection: vi.fn(() => mockSdkClient),
}))

vi.mock("./allowlist", () => ({ isQueryAllowed: vi.fn() }))
vi.mock("./rls", () => ({ applyRLS: vi.fn(async ({ sql }) => sql) }))
vi.mock("./cache", () => ({
    beforeQueryCache: vi.fn(async () => null),
    afterQueryCache: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockConfig = {
        outerbaseApiKey: "mock-api-key",
        role: "admin",
        features: { allowlist: true, rls: true, rest: true },
    }
    mockDataSource = {
        source: "internal",
        external: {
            dialect: "postgresql",
            host: "mock-host",
            port: 5432,
            user: "mock-user",
            password: "mock-password",
            database: "mock-db",
        },
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([
                { id: 1, name: "Alice" },
                { id: 2, name: "Bob" },
            ]),
        } as any,
    }
    vi.mocked(beforeQueryCache).mockResolvedValue(null)
})

describe("executeQuery and executeTransaction", () => {
    it("executes internal queries, enforces allowlist and RLS, and returns cached results", async () => {
        const result = await executeQuery({
            sql: "SELECT * FROM users",
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(isQueryAllowed).toHaveBeenCalledTimes(1)
        expect(applyRLS).toHaveBeenCalledTimes(1)
        expect(result).toEqual([
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
        ])

        vi.mocked(beforeQueryCache).mockResolvedValueOnce([
            { id: 99, name: "Cached" },
        ] as any)
        const cached = await executeQuery({
            sql: "SELECT * FROM users",
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(cached).toEqual([{ id: 99, name: "Cached" }])
    })

    it("transforms raw query results through registry hooks and handles hyperdrive pools", async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce({
            columns: ["id", "name"],
            rows: [[1, "Alice"]],
        } as any)
        mockDataSource.registry = {
            beforeQuery: vi.fn(async ({ sql, params }) => ({ sql, params })),
            afterQuery: vi.fn(async ({ result }) => result),
        } as any

        const rawResult = await executeQuery({
            sql: "SELECT id, name FROM users",
            params: [],
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(rawResult).toEqual({
            columns: ["id", "name"],
            rows: [[1, "Alice"]],
            meta: { rows_read: 1, rows_written: 0 },
        })

        const hdResult = await executeQuery({
            sql: "SELECT * FROM hd_table",
            params: [],
            isRaw: false,
            dataSource: {
                ...mockDataSource,
                source: "hyperdrive",
                external: {
                    dialect: "postgresql",
                    connectionString: "postgres://localhost/db",
                },
            },
            config: mockConfig,
        })
        expect(hdResult).toEqual([{ id: 10, name: "Hyperdrive-Row" }])
        expect(mockPgUnsafe.end).toHaveBeenCalled()
    })

    it("executes multi-statement transactions and handles missing dataSource", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {})
        expect(
            await executeQuery({
                sql: "SELECT 1",
                params: undefined,
                isRaw: false,
                dataSource: null as any,
                config: mockConfig,
            })
        ).toEqual([])
        expect(
            await executeTransaction({
                queries: [{ sql: "SELECT 1" }],
                isRaw: false,
                dataSource: null as any,
                config: mockConfig,
            })
        ).toEqual([])

        const txResult = await executeTransaction({
            queries: [{ sql: "INSERT INTO users VALUES (1)" }, { sql: "SELECT 1" }],
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(txResult).toHaveLength(2)
        consoleSpy.mockRestore()
    })
})

describe("executeExternalQuery and executeSDKQuery", () => {
    it("formats Outerbase API requests, handles malformed responses, and falls back to SDK", async () => {
        await expect(
            executeExternalQuery({
                sql: "SELECT 1",
                params: [],
                dataSource: { source: "internal" } as any,
                config: mockConfig,
            })
        ).rejects.toThrow("External connection not found.")

        vi.spyOn(global, "fetch").mockResolvedValueOnce({
            json: async () => ({
                response: { results: { items: [{ id: 2, name: "API-Result" }] } },
            }),
        } as Response)

        const apiRes = await executeExternalQuery({
            sql: "SELECT * FROM users WHERE id = ?",
            params: [5],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(apiRes).toEqual([{ id: 2, name: "API-Result" }])

        vi.spyOn(global, "fetch").mockResolvedValueOnce({
            json: async () => ({}),
        } as Response)
        const emptyApiRes = await executeExternalQuery({
            sql: "SELECT * FROM users",
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(emptyApiRes).toEqual([])

        const sdkFallbackRes = await executeExternalQuery({
            sql: "SELECT * FROM users",
            params: [],
            dataSource: mockDataSource,
            config: { ...mockConfig, outerbaseApiKey: undefined },
        })
        expect(sdkFallbackRes).toEqual([{ id: 1, name: "SDK-Test-Result" }])
    })

    it("connects and executes queries across all supported SDK external providers", async () => {
        const externalConfigs: any[] = [
            { dialect: "postgresql", host: "pg.local" },
            { dialect: "mysql", host: "mysql.local" },
            {
                dialect: "sqlite",
                provider: "cloudflare-d1",
                apiKey: "k",
                accountId: "a",
                databaseId: "d",
            },
            {
                dialect: "sqlite",
                provider: "starbase",
                apiKey: "u",
                token: "t",
            },
            { dialect: "sqlite", provider: "turso", uri: "u", token: "t" },
        ]

        for (const external of externalConfigs) {
            const res = await executeSDKQuery({
                sql: "SELECT * FROM users",
                params: [],
                dataSource: { ...mockDataSource, external },
                config: mockConfig,
            })
            expect(res).toEqual([{ id: 1, name: "SDK-Test-Result" }])
        }

        expect(mockSdkClient.connect).toHaveBeenCalledTimes(5)

        const noExtRes = await executeSDKQuery({
            sql: "SELECT 1",
            params: [],
            dataSource: { ...mockDataSource, external: undefined },
            config: mockConfig,
        })
        expect(noExtRes).toEqual([])
    })
})
