import { beforeEach, describe, expect, it, vi } from 'vitest'
import { login, signup } from './index'
import { encryptPassword } from '../utils'

const env = {
    PASSWORD_REQUIRE_LENGTH: 10,
    PASSWORD_REQUIRE_UPPERCASE: true,
    PASSWORD_REQUIRE_LOWERCASE: true,
    PASSWORD_REQUIRE_NUMBER: true,
    PASSWORD_REQUIRE_SPECIAL: true,
}

function createStub(...results: any[]) {
    return {
        executeExternalQuery: vi.fn().mockImplementation(() => {
            const nextResult = results.shift()
            return Promise.resolve(nextResult)
        }),
    }
}

describe('auth email signup', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('rejects missing signup fields before querying storage', async () => {
        const stub = createStub()

        const response = await signup(stub, env, {
            email: 'ada@example.com',
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Missing required fields',
        })
        expect(stub.executeExternalQuery).not.toHaveBeenCalled()
    })

    it('rejects passwords that do not satisfy the configured policy', async () => {
        const stub = createStub()

        const response = await signup(stub, env, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'short',
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: expect.stringContaining(
                'Password must be at least 10 characters'
            ),
        })
        expect(stub.executeExternalQuery).not.toHaveBeenCalled()
    })

    it('rejects duplicate usernames or emails', async () => {
        const stub = createStub({ result: [{ id: 1 }] })

        const response = await signup(stub, env, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Username or email already exists',
        })
        expect(stub.executeExternalQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM auth_users'),
            ['ada', 'ada@example.com']
        )
    })

    it('returns a server error when user creation does not return a user', async () => {
        const stub = createStub({ result: [] }, { result: [] })

        const response = await signup(stub, env, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(500)
        await expect(response.json()).resolves.toEqual({
            error: 'Failed to create user',
        })
    })

    it('creates a user and session for valid signup input', async () => {
        const encryptedPassword = await encryptPassword('ValidPass1!')
        const randomUUID = vi
            .spyOn(crypto, 'randomUUID')
            .mockReturnValue(
                'session-token' as ReturnType<typeof crypto.randomUUID>
            )
        const stub = createStub(
            { result: [] },
            {
                result: [
                    {
                        id: 42,
                        username: 'ada',
                        email: 'ada@example.com',
                    },
                ],
            },
            {
                result: [
                    {
                        user_id: 42,
                        session_token: 'session-token',
                        created_at: '2026-01-01T00:00:00Z',
                    },
                ],
            }
        )

        const response = await signup(stub, env, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            result: {
                user_id: 42,
                session_token: 'session-token',
                created_at: '2026-01-01T00:00:00Z',
            },
        })
        expect(stub.executeExternalQuery).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO auth_users'),
            ['ada', encryptedPassword, 'ada@example.com']
        )
        expect(stub.executeExternalQuery).toHaveBeenNthCalledWith(
            3,
            expect.stringContaining('INSERT INTO auth_sessions'),
            [42, 'session-token']
        )
        expect(randomUUID).toHaveBeenCalledTimes(1)
    })
})

describe('auth email login', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('rejects missing login fields before querying storage', async () => {
        const stub = createStub()

        const response = await login(stub, {
            email: 'ada@example.com',
        })

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Missing required fields',
        })
        expect(stub.executeExternalQuery).not.toHaveBeenCalled()
    })

    it('returns not found when credentials do not match a user', async () => {
        const encryptedPassword = await encryptPassword('ValidPass1!')
        const stub = createStub({ result: [] })

        const response = await login(stub, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toEqual({
            error: 'User not found',
        })
        expect(stub.executeExternalQuery).toHaveBeenCalledWith(
            expect.stringContaining('SELECT * FROM auth_users'),
            ['ada', 'ada@example.com', encryptedPassword]
        )
    })

    it('returns a server error when session creation fails', async () => {
        vi.spyOn(crypto, 'randomUUID').mockReturnValue(
            'session-token' as ReturnType<typeof crypto.randomUUID>
        )
        const stub = createStub({ result: [{ id: 42 }] }, { result: [] })

        const response = await login(stub, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(500)
        await expect(response.json()).resolves.toEqual({
            error: 'Failed to create session',
        })
    })

    it('creates a session for a valid login', async () => {
        const randomUUID = vi
            .spyOn(crypto, 'randomUUID')
            .mockReturnValue(
                'login-session' as ReturnType<typeof crypto.randomUUID>
            )
        const stub = createStub(
            { result: [{ id: 42, username: 'ada' }] },
            {
                result: [
                    {
                        user_id: 42,
                        session_token: 'login-session',
                        created_at: '2026-01-01T00:00:00Z',
                    },
                ],
            }
        )

        const response = await login(stub, {
            username: 'ada',
            email: 'ada@example.com',
            password: 'ValidPass1!',
        })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            result: {
                user_id: 42,
                session_token: 'login-session',
                created_at: '2026-01-01T00:00:00Z',
            },
        })
        expect(stub.executeExternalQuery).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO auth_sessions'),
            [42, 'login-session']
        )
        expect(randomUUID).toHaveBeenCalledTimes(1)
    })
})
