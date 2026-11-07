import { describe, it, expect, vi, beforeEach } from "vitest"
import worker, { Env } from "./index"
import { StarbaseDB } from "./handler"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { InterfacePlugin } from "../plugins/interface"

vi.mock("cloudflare:workers", () => ({
    DurableObject: class MockDurableObject {},
}))

vi.mock("jose", () => ({
    createRemoteJWKSet: vi.fn().mockReturnValue("mock-jwks"),
    jwtVerify: vi.fn(),
}))

const mockHandle = vi.fn().mockResolvedValue(new Response("handled", { status: 200 }))
const mockHandlePreAuth = vi.fn().mockResolvedValue(undefined)

vi.mock("./handler", () => ({
    StarbaseDB: vi.fn().mockImplementation((opts) => ({
        opts,
        handle: mockHandle,
        handlePreAuth: mockHandlePreAuth,
    })),
}))

// Constructs a minimal Cloudflare Worker Env binding set for testing worker.fetch.
function createMockEnv(overrides: Partial<Env> = {}): Env {
    const stub = { init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }) }
    return {
        ADMIN_AUTHORIZATION_TOKEN: "admin-secret",
        CLIENT_AUTHORIZATION_TOKEN: "client-secret",
        REGION: "auto",
        DATABASE_DURABLE_OBJECT: {
            idFromName: vi.fn().mockReturnValue("do-id"),
            get: vi.fn().mockReturnValue(stub),
        } as unknown as Env["DATABASE_DURABLE_OBJECT"],
        HYPERDRIVE: {} as Hyperdrive,
        ...overrides,
    }
}

const mockCtx = { waitUntil: vi.fn() } as unknown as ExecutionContext

describe("Worker fetch routing and authentication", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockHandlePreAuth.mockResolvedValue(undefined)
    })

    it("handles CORS OPTIONS preflight and pre-auth plugin responses", async () => {
        const env = createMockEnv()
        const optionsRes = await worker.fetch(
            new Request("https://example.com/query", { method: "OPTIONS" }),
            env,
            mockCtx
        )
        expect(optionsRes.status).toBe(200)

        mockHandlePreAuth.mockResolvedValueOnce(
            new Response("pre-auth-ok", { status: 202 })
        )
        const preAuthRes = await worker.fetch(
            new Request("https://example.com/public"),
            env,
            mockCtx
        )
        expect(preAuthRes.status).toBe(202)
    })

    it("rejects missing tokens with 401 and authorizes admin, client, and WebSocket tokens", async () => {
        const env = createMockEnv({ REGION: "wnam" })
        const missingRes = await worker.fetch(
            new Request("https://example.com/query"),
            env,
            mockCtx
        )
        expect(missingRes.status).toBe(401)

        const adminRes = await worker.fetch(
            new Request("https://example.com/query", {
                headers: { Authorization: "Bearer admin-secret" },
            }),
            env,
            mockCtx
        )
        expect(adminRes.status).toBe(200)

        const wsRes = await worker.fetch(
            new Request("https://example.com/socket?token=client-secret", {
                headers: { Upgrade: "websocket" },
            }),
            env,
            mockCtx
        )
        expect(wsRes.status).toBe(200)
    })

    it("validates JWKS JWT tokens and returns 400 on invalid tokens or missing sub", async () => {
        const envNoJwks = createMockEnv()
        const badTokenRes = await worker.fetch(
            new Request("https://example.com/query", {
                headers: { Authorization: "Bearer unknown-jwt" },
            }),
            envNoJwks,
            mockCtx
        )
        expect(badTokenRes.status).toBe(400)

        const envWithJwks = createMockEnv({
            AUTH_JWKS_ENDPOINT: "https://auth.example.com/.well-known/jwks.json",
            AUTH_ALGORITHM: "RS256",
        })
        vi.mocked(jwtVerify).mockResolvedValueOnce({
            payload: { sub: "user-42" },
        } as any)

        const validJwtRes = await worker.fetch(
            new Request("https://example.com/query", {
                headers: { Authorization: "Bearer valid-jwt" },
            }),
            envWithJwks,
            mockCtx
        )
        expect(validJwtRes.status).toBe(200)
        expect(createRemoteJWKSet).toHaveBeenCalled()
    })
})

describe("Worker external database dialect configuration", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("configures postgresql, mysql, sqlite providers, and Hyperdrive sources", async () => {
        const dialects: Partial<Env>[] = [
            { EXTERNAL_DB_TYPE: "postgresql", EXTERNAL_DB_HOST: "pg.local" },
            { EXTERNAL_DB_TYPE: "mysql", EXTERNAL_DB_HOST: "mysql.local" },
            {
                EXTERNAL_DB_TYPE: "sqlite",
                EXTERNAL_DB_CLOUDFLARE_API_KEY: "cf-key",
                EXTERNAL_DB_STARBASEDB_URI: "https://sb.local",
                EXTERNAL_DB_TURSO_URI: "libsql://turso.local",
            },
            {
                HYPERDRIVE: {
                    connectionString: "postgres://user:pass@hd.local:5432/db",
                } as Hyperdrive,
            },
        ]

        for (const dialectEnv of dialects) {
            const res = await worker.fetch(
                new Request("https://example.com/query?source=external", {
                    headers: { Authorization: "Bearer admin-secret" },
                }),
                createMockEnv(dialectEnv),
                mockCtx
            )
            expect(res.status).toBe(200)
        }

        expect(StarbaseDB).toHaveBeenCalledTimes(4)
    })

    it("routes matching InterfacePlugin paths directly before token checks", async () => {
        vi.spyOn(
            InterfacePlugin.prototype,
            "matchesRoute"
        ).mockReturnValueOnce(true)

        const res = await worker.fetch(
            new Request("https://example.com/ui"),
            createMockEnv(),
            mockCtx
        )
        expect(res.status).toBe(200)
    })
})
