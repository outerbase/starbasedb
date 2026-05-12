import { describe, expect, test } from 'vitest'

import { createResponse } from './utils'

describe('createResponse', () => {
    test('returns success response with data', async () => {
        const data = { foo: 'bar' }
        const response = createResponse(data, undefined, 200)

        expect(await response.json()).toEqual({
            result: data,
        })

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    test('returns error response', async () => {
        const error = 'Something went wrong'
        const response = createResponse(undefined, error, 500)

        expect(await response.json()).toEqual({
            error,
        })

        expect(response.status).toBe(500)
        expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    test('keeps both result and error when both are supplied', async () => {
        const response = createResponse({ imported: 2 }, 'Partial failure', 207)

        expect(response.status).toBe(207)
        expect(await response.json()).toEqual({
            result: { imported: 2 },
            error: 'Partial failure',
        })
    })
})
