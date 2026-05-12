import { expect, test } from 'vitest'

import { createResponse } from './utils'

test('createResponse returns success response with data', async () => {
    const data = { foo: 'bar' }
    const response = createResponse(data, undefined, 200)

    expect(await response.json()).toEqual({
        result: data,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
})

test('createResponse returns error response', async () => {
    const error = 'Something went wrong'
    const response = createResponse(undefined, error, 500)

    expect(await response.json()).toEqual({
        error,
    })

    expect(response.status).toBe(500)
})

test('createResponse preserves explicit result and error keys when both are present', async () => {
    const response = createResponse({ ok: false }, 'Bad request', 400)

    expect(await response.json()).toEqual({
        result: { ok: false },
        error: 'Bad request',
    })
    expect(response.status).toBe(400)
})
