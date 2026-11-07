import { describe, expect, it, vi, beforeEach } from "vitest"
import { StarbaseDBDurableObject } from "./do"

vi.mock("cloudflare:workers", () => ({
    DurableObject: class MockDurableObject {
        ctx: any
        constructor(ctx: any) {
            this.ctx = ctx
        }
    },
}))

declare global {
    var WebSocket: any
    var WebSocketPair: any
    var Response: typeof globalThis.Response
}

global.WebSocket = class {
    static READY_STATE_CONNECTING = 0
    static READY_STATE_OPEN = 1
    static READY_STATE_CLOSING = 2
    static READY_STATE_CLOSED = 3
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = 0
    send = vi.fn()
    close = vi.fn()
    accept = vi.fn()
    addEventListener = vi.fn()
}

global.WebSocketPair = vi.fn(() => {
    const client = new global.WebSocket("ws://localhost")
    const server = new global.WebSocket("ws://localhost")
    return { 0: client, 1: server }
})

global.Response = class {
    body: any
    status: any
    webSocket: any
    constructor(body?: any, init?: any) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
    }
} as any

const mockStorage = {
    getAlarm: vi.fn().mockResolvedValue(1700000000000),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    sql: {
        databaseSize: 4096,
        exec: vi.fn().mockReturnValue({
            columnNames: ["id", "name"],
            raw: vi.fn().mockReturnValue([
                [1, "Alice"],
                [2, "Bob"],
            ]),
            toArray: vi.fn().mockReturnValue([
                { id: 1, name: "Alice", count: 5 },
                { id: 2, name: "Bob" },
            ]),
            rowsRead: 2,
            rowsWritten: 1,
        }),
    },
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(["session-123"]),
} as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    instance = new StarbaseDBDurableObject(mockDurableObjectState, {
        CLIENT_AUTHORIZATION_TOKEN: "client-token",
    } as any)
    vi.clearAllMocks()
})

describe("StarbaseDBDurableObject SQL and statistics", () => {
    it("initializes RPC bindings, executes raw/array queries, and reports statistics", async () => {
        const rpc = instance.init()
        expect(rpc.executeQuery).toBeDefined()

        const rows = await instance.executeQuery({
            sql: "SELECT * FROM users WHERE id = ?",
            params: [1],
        })
        expect(mockStorage.sql.exec).toHaveBeenCalledWith(
            "SELECT * FROM users WHERE id = ?",
            1
        )
        expect(rows).toHaveLength(2)

        const rawRes = await instance.executeQuery({
            sql: "SELECT * FROM users",
            isRaw: true,
        })
        expect(rawRes).toEqual({
            columns: ["id", "name"],
            rows: [
                [1, "Alice"],
                [2, "Bob"],
            ],
            meta: { rows_read: 2, rows_written: 1 },
        })

        const stats = await instance.getStatistics()
        expect(stats.databaseSize).toBe(4096)
        expect(stats.recentQueries).toBe(5)
    })

    it("executes transactions and propagates SQL execution errors", async () => {
        const txRes = await instance.executeTransaction(
            [{ sql: "SELECT * FROM orders" }, { sql: "SELECT * FROM products" }],
            false
        )
        expect(txRes).toHaveLength(2)

        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {})
        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error("Query failed")
        })
        await expect(
            instance.executeQuery({ sql: "INVALID QUERY" })
        ).rejects.toThrow("Query failed")
        consoleSpy.mockRestore()
    })
})

describe("StarbaseDBDurableObject alarms and WebSocket lifecycle", () => {
    it("manages alarm scheduling and triggers cron callbacks with recovery fallback", async () => {
        expect(await instance.getAlarm()).toBe(1700000000000)
        await instance.setAlarm(new Date(Date.now() + 5000))
        expect(mockStorage.setAlarm).toHaveBeenCalled()
        await instance.deleteAlarm()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()

        vi.spyOn(instance, "executeQuery").mockResolvedValueOnce([
            { callback_host: "https://worker.local", is_active: 1 },
        ] as any)
        const fetchSpy = vi
            .spyOn(global, "fetch")
            .mockResolvedValueOnce(new Response("ok") as any)

        await instance.alarm()
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://worker.local/cron/callback",
            expect.objectContaining({ method: "POST" })
        )
    })

    it("handles socket upgrades, broadcast filtering, messages, and socket closure", async () => {
        const upgradeRes = await instance.fetch(
            new Request("https://example.com/socket?sessionId=session-123", {
                headers: { upgrade: "websocket" },
            })
        )
        expect(upgradeRes.status).toBe(101)
        expect(instance.connections.has("session-123")).toBe(true)

        const badSocketRes = await instance.fetch(
            new Request("https://example.com/socket")
        )
        expect(badSocketRes.status).toBe(400)

        const broadcastRes = await instance.fetch(
            new Request(
                "https://example.com/socket/broadcast?sessionId=session-123",
                {
                    method: "POST",
                    body: JSON.stringify({ event: "row_updated" }),
                }
            )
        )
        expect(broadcastRes.status).toBe(200)

        const ws = instance.connections.get("session-123")!
        await instance.webSocketMessage(
            ws,
            JSON.stringify({ action: "query", sql: "SELECT 1", params: [] })
        )
        expect(ws.send).toHaveBeenCalled()

        await instance.webSocketClose(ws, 1000, "normal", true)
        expect(instance.connections.has("session-123")).toBe(false)
    })
})
