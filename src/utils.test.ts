import { expect, test } from 'vitest'

import { createResponse } from './utils'

test('createResponse returns success response with data', async () => {
    const data = { foo: 'bar' }
    const response = createResponse(data, undefined, 200)

    expect(await response.json()).toEqual({
        result: data,
    })

    expect(response.status).toBe(200)
})

test('createResponse returns error response', async () => {
    const error = 'Something went wrong'
    const response = createResponse(undefined, error, 500)

    expect(await response.json()).toEqual({
        error,
    })

    expect(response.status).toBe(500)
})
