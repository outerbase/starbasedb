import { describe, expect, it } from 'vitest'
import { createResponse, encryptPassword, verifyPassword } from './utils'

const strictPasswordEnv = {
    PASSWORD_REQUIRE_LENGTH: 10,
    PASSWORD_REQUIRE_UPPERCASE: true,
    PASSWORD_REQUIRE_LOWERCASE: true,
    PASSWORD_REQUIRE_NUMBER: true,
    PASSWORD_REQUIRE_SPECIAL: true,
}

describe('auth template utils - createResponse', () => {
    it('returns JSON response payloads with the requested status', async () => {
        const response = createResponse({ success: true }, undefined, 201)

        expect(response.status).toBe(201)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual({
            result: { success: true },
        })
    })

    it('includes error messages when result data is absent', async () => {
        const response = createResponse(
            undefined,
            'Missing required fields',
            400
        )

        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({
            error: 'Missing required fields',
        })
    })
})

describe('auth template utils - verifyPassword', () => {
    it('accepts passwords that satisfy every configured policy', () => {
        expect(verifyPassword(strictPasswordEnv, 'ValidPass1!')).toBe(true)
    })

    it.each([
        ['length', 'V1!a'],
        ['uppercase', 'validpass1!'],
        ['lowercase', 'VALIDPASS1!'],
        ['number', 'ValidPass!!'],
        ['special', 'ValidPass12'],
    ])('rejects passwords missing the required %s rule', (_rule, password) => {
        expect(verifyPassword(strictPasswordEnv, password)).toBe(false)
    })
})

describe('auth template utils - encryptPassword', () => {
    it('hashes the same password to the same stable value', async () => {
        await expect(encryptPassword('ValidPass1!')).resolves.toBe(
            await encryptPassword('ValidPass1!')
        )
    })

    it('hashes different passwords to different values', async () => {
        await expect(encryptPassword('ValidPass1!')).resolves.not.toBe(
            await encryptPassword('AnotherPass1!')
        )
    })
})
