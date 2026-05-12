import { describe, expect, test } from 'vitest'
import { corsHeaders, corsPreflight } from './cors'

describe('corsPreflight', () => {
    test('returns a Response instance with correct headers', () => {
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
        expect(response.status).toBe(204)
        expect(response.body).toBeNull()
    })

    test('advertises the complete StarbaseDB request header contract', () => {
        const headers = corsPreflight().headers

        expect(headers.get('Access-Control-Allow-Headers')).toBe(
            'Authorization, Content-Type, X-Starbase-Source, X-Data-Source'
        )
        expect(headers.get('Access-Control-Max-Age')).toBe('86400')
    })

    test('allows all HTTP methods used by the API surface', () => {
        const methods = corsPreflight()
            .headers.get('Access-Control-Allow-Methods')!
            .split(', ')

        expect(methods).toEqual([
            'GET',
            'POST',
            'PATCH',
            'PUT',
            'DELETE',
            'OPTIONS',
        ])
    })
})
