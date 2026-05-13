import { expect, test } from 'vitest'
import { corsHeaders, corsPreflight } from './cors'

test('it should return a Response instance with correct headers', () => {
    const response = corsPreflight()
    expect(response).toBeInstanceOf(Response)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
        corsHeaders['Access-Control-Allow-Origin']
    )
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
        corsHeaders['Access-Control-Allow-Methods']
    )
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
        corsHeaders['Access-Control-Allow-Headers']
    )
    expect(response.headers.get('Access-Control-Max-Age')).toBe(
        corsHeaders['Access-Control-Max-Age']
    )
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
})

test('corsHeaders expose the expected CORS contract', () => {
    expect(corsHeaders).toEqual({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods':
            'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-Starbase-Source, X-Data-Source',
        'Access-Control-Max-Age': '86400',
    })
})
