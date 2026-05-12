import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource } from '../../src/types'

const clerkMocks = vi.hoisted(() => ({
    webhookVerify: vi.fn(),
    importSPKI: vi.fn(),
    jwtVerify: vi.fn(),
}))

vi.mock('svix', () => ({
    Webhook: vi.fn().mockImplementation(() => ({
        verify: clerkMocks.webhookVerify,
    })),
}))

vi.mock('jose', () => ({
    importSPKI: clerkMocks.importSPKI,
    jwtVerify: clerkMocks.jwtVerify,
}))

import { ClerkPlugin } from './index'

const sqlPaths = {
    createUserTable: '/plugins/clerk/sql/create-user-table.sql',
    createSessionTable: '/plugins/clerk/sql/create-session-table.sql',
    upsertUser: '/plugins/clerk/sql/upsert-user.sql',
    deleteUser: '/plugins/clerk/sql/delete-user.sql',
    upsertSession: '/plugins/clerk/sql/upsert-session.sql',
    deleteSession: '/plugins/clerk/sql/delete-session.sql',
    getSession: '/plugins/clerk/sql/get-session.sql',
}

const createMockDataSource = (results: unknown[] = []) => {
    const executeQuery = vi.fn()

    for (const result of results) {
        executeQuery.mockResolvedValueOnce(result)
    }

    executeQuery.mockResolvedValue([])

    return {
        rpc: {
            executeQuery,
        },
    } as unknown as DataSource
}

const svixHeaders = {
    'svix-id': 'msg_123',
    'svix-signature': 'v1,signature',
    'svix-timestamp': '1700000000',
}

async function createRegisteredPlugin(opts?: {
    dataSource?: DataSource
    clerkInstanceId?: string
    verifySessions?: boolean
    permittedOrigins?: string[]
}) {
    const app = new Hono()
    const dataSource = opts?.dataSource ?? createMockDataSource()
    const plugin = new ClerkPlugin({
        clerkSigningSecret: 'whsec_test',
        clerkSessionPublicKey:
            '-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----',
        clerkInstanceId: opts?.clerkInstanceId,
        verifySessions: opts?.verifySessions,
        permittedOrigins: opts?.permittedOrigins,
        dataSource,
    })

    await plugin.register(app as any)

    return { app, dataSource, plugin }
}

describe('ClerkPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('requires a Clerk signing secret during construction', () => {
        expect(() => new ClerkPlugin(undefined as any)).toThrowError(
            'A signing secret is required for this plugin.'
        )
    })

    it('creates user and session tables when session verification is enabled', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({ dataSource })

        const response = await app.request('/clerk/webhook', {
            method: 'POST',
            body: '{}',
        })

        expect(response.status).toBe(400)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.createUserTable,
            params: [],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.createSessionTable,
            params: [],
        })
    })

    it('skips session table creation when session verification is disabled', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({
            dataSource,
            verifySessions: false,
        })

        await app.request('/clerk/webhook', {
            method: 'POST',
            body: '{}',
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.createUserTable,
            params: [],
        })
    })

    it('rejects webhook requests missing svix headers', async () => {
        const { app } = await createRegisteredPlugin()

        const response = await app.request('/clerk/webhook', {
            method: 'POST',
            body: '{}',
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Missing required headers: svix-id, svix-signature, svix-timestamp',
        })
    })

    it('upserts users from created and updated webhook events', async () => {
        const dataSource = createMockDataSource()
        clerkMocks.webhookVerify.mockReturnValue({
            type: 'user.created',
            instance_id: 'inst_123',
            data: {
                id: 'user_123',
                first_name: 'Ada',
                last_name: 'Lovelace',
                primary_email_address_id: 'email_2',
                email_addresses: [
                    { id: 'email_1', email_address: 'old@example.com' },
                    { id: 'email_2', email_address: 'ada@example.com' },
                ],
            },
        })
        const { app } = await createRegisteredPlugin({
            dataSource,
            clerkInstanceId: 'inst_123',
        })

        const response = await app.request('/clerk/webhook', {
            method: 'POST',
            headers: svixHeaders,
            body: JSON.stringify({ payload: true }),
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.upsertUser,
            params: ['user_123', 'ada@example.com', 'Ada', 'Lovelace'],
        })
    })

    it('rejects webhook events from unexpected Clerk instances', async () => {
        const dataSource = createMockDataSource()
        clerkMocks.webhookVerify.mockReturnValue({
            type: 'user.deleted',
            instance_id: 'wrong_instance',
            data: { id: 'user_123' },
        })
        const { app } = await createRegisteredPlugin({
            dataSource,
            clerkInstanceId: 'inst_123',
        })

        const response = await app.request('/clerk/webhook', {
            method: 'POST',
            headers: svixHeaders,
            body: '{}',
        })

        expect(response.status).toBe(401)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalledWith({
            sql: sqlPaths.deleteUser,
            params: ['user_123'],
        })
    })

    it('persists and deletes Clerk sessions from webhook events', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({ dataSource })

        clerkMocks.webhookVerify.mockReturnValueOnce({
            type: 'session.created',
            instance_id: 'inst_123',
            data: { id: 'sess_123', user_id: 'user_123' },
        })
        await app.request('/clerk/webhook', {
            method: 'POST',
            headers: svixHeaders,
            body: '{}',
        })

        clerkMocks.webhookVerify.mockReturnValueOnce({
            type: 'session.revoked',
            instance_id: 'inst_123',
            data: { id: 'sess_123', user_id: 'user_123' },
        })
        await app.request('/clerk/webhook', {
            method: 'POST',
            headers: svixHeaders,
            body: '{}',
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.upsertSession,
            params: ['sess_123', 'user_123'],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.deleteSession,
            params: ['sess_123', 'user_123'],
        })
    })

    it('returns false when session verification is disabled or public key is missing', async () => {
        const disabledPlugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test',
            verifySessions: false,
            dataSource: createMockDataSource(),
        })
        const missingKeyPlugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test',
            dataSource: createMockDataSource(),
        })

        await expect(
            disabledPlugin.authenticate({ token: 'token' })
        ).resolves.toBe(false)
        await expect(
            missingKeyPlugin.authenticate({ token: 'token' })
        ).resolves.toBe(false)
    })

    it('authenticates valid session tokens that exist in the database', async () => {
        const dataSource = createMockDataSource([[{ id: 'sess_123' }]])
        const plugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test',
            clerkSessionPublicKey: 'public-key',
            permittedOrigins: ['https://app.example.com'],
            dataSource,
        })
        const payload = {
            sid: 'sess_123',
            sub: 'user_123',
            exp: Math.floor(Date.now() / 1000) + 60,
            azp: 'https://app.example.com',
        }
        clerkMocks.importSPKI.mockResolvedValue('imported-key')
        clerkMocks.jwtVerify.mockResolvedValue({ payload })

        const result = await plugin.authenticate({
            cookie: '__session=session-cookie',
        })

        expect(result).toBe(payload)
        expect(clerkMocks.importSPKI).toHaveBeenCalledWith(
            'public-key',
            'RS256'
        )
        expect(clerkMocks.jwtVerify).toHaveBeenCalledWith(
            'session-cookie',
            'imported-key'
        )
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: sqlPaths.getSession,
            params: ['sess_123', 'user_123'],
        })
    })

    it('rejects valid JWTs when the session is missing from the database', async () => {
        const dataSource = createMockDataSource([[]])
        const plugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test',
            clerkSessionPublicKey: 'public-key',
            dataSource,
        })
        clerkMocks.importSPKI.mockResolvedValue('imported-key')
        clerkMocks.jwtVerify.mockResolvedValue({
            payload: {
                sid: 'missing_session',
                sub: 'user_123',
                exp: Math.floor(Date.now() / 1000) + 60,
            },
        })

        await expect(plugin.authenticate({ token: 'jwt-token' })).resolves.toBe(
            false
        )
    })

    it('returns false when session lookup fails', async () => {
        const dataSource = {
            rpc: {
                executeQuery: vi.fn().mockRejectedValue(new Error('db down')),
            },
        } as unknown as DataSource
        const plugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test',
            dataSource,
        })

        await expect(
            plugin.sessionExistsInDb({ sid: 'sess_123', sub: 'user_123' })
        ).resolves.toBe(false)
    })
})
