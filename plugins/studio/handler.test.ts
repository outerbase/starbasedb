import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { StarbaseApp } from '../../src/handler'
import { handleStudioRequest } from './handler'
import { StudioPlugin } from './index'

const studioOptions = {
    username: 'admin',
    password: 'secret',
    apiKey: 'studio-api-key',
}

const basicAuthorization = (credentials: string) => `Basic ${btoa(credentials)}`

async function expectUnauthorized(response: Response) {
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe(
        'Basic realm="Access to the studio"'
    )
    await expect(response.text()).resolves.toBe('Unauthorized')
}

describe('handleStudioRequest', () => {
    it('should reject requests without basic authorization', async () => {
        const request = new Request('https://example.com/studio')

        const response = await handleStudioRequest(request, studioOptions)

        await expectUnauthorized(response)
    })

    it('should reject non-basic authorization headers', async () => {
        const request = new Request('https://example.com/studio', {
            headers: { Authorization: 'Bearer token' },
        })

        const response = await handleStudioRequest(request, studioOptions)

        await expectUnauthorized(response)
    })

    it('should reject invalid basic credentials', async () => {
        const request = new Request('https://example.com/studio', {
            headers: {
                Authorization: basicAuthorization('admin:wrong-password'),
            },
        })

        const response = await handleStudioRequest(request, studioOptions)

        await expectUnauthorized(response)
    })

    it('should return studio HTML for valid basic credentials', async () => {
        const request = new Request('https://example.com/studio', {
            headers: {
                Authorization: basicAuthorization('admin:secret'),
            },
        })

        const response = await handleStudioRequest(request, studioOptions)
        const html = await response.text()

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/html')
        expect(html).toContain(
            '<title>Your Starbase - Outerbase Studio</title>'
        )
        expect(html).toContain(
            'src="https://studio.outerbase.com/embed/starbase"'
        )
        expect(html).toContain('fetch("/query/raw"')
        expect(html).toContain('"Authorization": "Bearer studio-api-key"')
        expect(html).toContain("e.data.type === 'transaction'")
    })
})

describe('StudioPlugin', () => {
    it('should initialize as an unauthenticated studio route plugin', () => {
        const plugin = new StudioPlugin({ apiKey: 'studio-api-key' })

        expect(plugin.name).toBe('starbasedb:studio')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.pathPrefix).toBe('/studio')
    })

    it('should register studio handler at a custom prefix', async () => {
        const app = new Hono()
        const plugin = new StudioPlugin({
            ...studioOptions,
            prefix: '/admin/studio',
        })

        await plugin.register(app as unknown as StarbaseApp)

        const rejectedResponse = await app.request('/admin/studio')
        await expectUnauthorized(rejectedResponse)

        const acceptedResponse = await app.request('/admin/studio', {
            headers: {
                Authorization: basicAuthorization('admin:secret'),
            },
        })
        const html = await acceptedResponse.text()

        expect(acceptedResponse.status).toBe(200)
        expect(html).toContain('Bearer studio-api-key')
    })
})
