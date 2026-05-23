import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleApiRequest } from './api'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'

vi.mock('./api', () => ({
    handleApiRequest: vi.fn(),
}))

function createDataSource(): DataSource {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn(),
        },
    } as unknown as DataSource
}

function createExecutionContext() {
    const waitUntil = vi.fn()

    return {
        ctx: { waitUntil } as unknown as ExecutionContext,
        waitUntil,
    }
}

function createStarbaseDB() {
    return new StarbaseDB({
        dataSource: createDataSource(),
        config: {
            role: 'admin',
            features: {
                export: false,
                import: false,
                rest: false,
            },
        },
    })
}

beforeEach(() => {
    vi.mocked(handleApiRequest).mockReset()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('StarbaseDB public routes', () => {
    it('proxies the Cloudflare trace endpoint response', async () => {
        const traceResponse = new Response('colo=YYZ\nhttp=http/2\n', {
            headers: {
                'content-type': 'text/plain',
                'x-trace-source': 'cloudflare',
            },
        })
        const fetchMock = vi.fn().mockResolvedValue(traceResponse)
        vi.stubGlobal('fetch', fetchMock)

        const db = createStarbaseDB()
        const { ctx, waitUntil } = createExecutionContext()

        const response = await db.handle(
            new Request('https://example.com/status/trace'),
            ctx
        )

        expect(fetchMock).toHaveBeenCalledWith(
            'https://cloudflare.com/cdn-cgi/trace'
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(response.headers.get('x-trace-source')).toBe('cloudflare')
        expect(await response.text()).toBe('colo=YYZ\nhttp=http/2\n')
        expect(waitUntil).toHaveBeenCalledTimes(1)
    })

    it('passes /api requests through the API handler', async () => {
        vi.mocked(handleApiRequest).mockResolvedValue(
            new Response('api-response', { status: 202 })
        )
        const db = createStarbaseDB()
        const { ctx } = createExecutionContext()
        const request = new Request('https://example.com/api/tables')

        const response = await db.handle(request, ctx)

        expect(handleApiRequest).toHaveBeenCalledWith(request)
        expect(response.status).toBe(202)
        expect(await response.text()).toBe('api-response')
    })

    it('returns a JSON 404 for unmatched routes', async () => {
        const db = createStarbaseDB()
        const { ctx } = createExecutionContext()

        const response = await db.handle(
            new Request('https://example.com/missing'),
            ctx
        )

        await expect(response.json()).resolves.toEqual({
            error: 'Not found',
        })
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toContain(
            'application/json'
        )
    })

    it('formats route handler errors as JSON 500 responses', async () => {
        vi.mocked(handleApiRequest).mockRejectedValue(new Error('api failed'))
        const db = createStarbaseDB()
        const { ctx } = createExecutionContext()

        const response = await db.handle(
            new Request('https://example.com/api/fail'),
            ctx
        )

        await expect(response.json()).resolves.toEqual({
            error: 'api failed',
        })
        expect(response.status).toBe(500)
        expect(response.headers.get('content-type')).toContain(
            'application/json'
        )
    })
})
