import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
    WorkerEntrypoint: class {
        env: unknown
    },
}))

vi.mock('./email', () => ({
    login: vi.fn(async () => new Response('login-response')),
    signup: vi.fn(async () => new Response('signup-response')),
}))

import AuthEntrypoint from './index'
import { login, signup } from './email'

function createEntrypoint() {
    const durableObjectId = { name: 'sql-durable-object' }
    const stub = {
        executeExternalQuery: vi.fn(),
    }
    const namespace = {
        idFromName: vi.fn(() => durableObjectId),
        get: vi.fn(() => stub),
    }

    const entrypoint = Object.create(
        AuthEntrypoint.prototype
    ) as AuthEntrypoint & {
        env: {
            DATABASE_DURABLE_OBJECT: typeof namespace
        }
    }
    entrypoint.env = {
        DATABASE_DURABLE_OBJECT: namespace,
    }

    return { entrypoint, namespace, durableObjectId, stub }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('AuthEntrypoint fetch', () => {
    it('returns 404 for the unnamed fetch handler', async () => {
        const { entrypoint } = createEntrypoint()

        const response = await entrypoint.fetch()

        expect(response.status).toBe(404)
    })
})

describe('AuthEntrypoint handleAuth', () => {
    it('routes signup requests to the email signup handler with the durable object stub', async () => {
        const { entrypoint, namespace, durableObjectId, stub } =
            createEntrypoint()
        const body = { email: 'ada@example.com', password: 'Secret123!' }

        const response = await entrypoint.handleAuth(
            '/auth/signup',
            'POST',
            body
        )

        expect(namespace.idFromName).toHaveBeenCalledWith('sql-durable-object')
        expect(namespace.get).toHaveBeenCalledWith(durableObjectId)
        expect(signup).toHaveBeenCalledWith(stub, entrypoint.env, body)
        expect(await response.text()).toBe('signup-response')
    })

    it('routes login requests to the email login handler with the durable object stub', async () => {
        const { entrypoint, stub } = createEntrypoint()
        const body = { username: 'ada', password: 'Secret123!' }

        const response = await entrypoint.handleAuth(
            '/auth/login',
            'POST',
            body
        )

        expect(login).toHaveBeenCalledWith(stub, body)
        expect(await response.text()).toBe('login-response')
    })

    it('routes logout requests to session invalidation', async () => {
        const { entrypoint, stub } = createEntrypoint()
        stub.executeExternalQuery.mockResolvedValueOnce({ result: [] })

        const response = await entrypoint.handleAuth('/auth/logout', 'POST', {
            user_id: 'user-1',
        })

        expect(stub.executeExternalQuery).toHaveBeenCalledWith(
            'UPDATE auth_sessions SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            ['user-1']
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            result: JSON.stringify({ success: true }),
        })
    })

    it('returns 405 for unsupported auth routes', async () => {
        const { entrypoint } = createEntrypoint()

        const response = await entrypoint.handleAuth('/auth/signup', 'GET', {})

        expect(response.status).toBe(405)
        expect(signup).not.toHaveBeenCalled()
        expect(login).not.toHaveBeenCalled()
    })
})

describe('AuthEntrypoint isSessionValid', () => {
    it('returns true when an undeleted session is found', async () => {
        const { entrypoint, stub } = createEntrypoint()
        ;(entrypoint as any).stub = stub
        stub.executeExternalQuery.mockResolvedValueOnce({
            result: [{ session_token: 'token-1' }],
        })

        await expect(entrypoint.isSessionValid('token-1')).resolves.toBe(true)
        expect(stub.executeExternalQuery).toHaveBeenCalledWith(
            `SELECT * FROM auth_sessions 
             WHERE session_token = ? 
             AND deleted_at IS NULL`,
            ['token-1']
        )
    })

    it('returns false when no active session exists', async () => {
        const { entrypoint, stub } = createEntrypoint()
        ;(entrypoint as any).stub = stub
        stub.executeExternalQuery.mockResolvedValueOnce({ result: [] })

        await expect(entrypoint.isSessionValid('missing-token')).resolves.toBe(
            false
        )
    })
})
