import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ResendPlugin } from './index'

function jsonResponse(body: any, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
    } as any
}

describe('ResendPlugin - identity and construction', () => {
    it('registers under the resend plugin name without requiring auth', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test' })
        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.apiKey).toBe('re_test')
    })

    it('constructs without options and leaves the key undefined', () => {
        const plugin = new ResendPlugin()
        expect(plugin.apiKey).toBeUndefined()
    })
})

describe('ResendPlugin - sendEmail', () => {
    const realFetch = globalThis.fetch

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        globalThis.fetch = realFetch
    })

    it('posts to the Resend API with bearer auth and returns the payload', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ id: 'em_123' }))
        globalThis.fetch = fetchMock as any

        const plugin = new ResendPlugin({ apiKey: 're_test' })
        const data = await plugin.sendEmail(
            'onboarding@resend.dev',
            ['to@example.com'],
            'hello',
            '<p>hi</p>'
        )

        expect(data).toEqual({ id: 'em_123' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://api.resend.com/emails')
        expect(init.method).toBe('POST')
        expect(init.headers.Authorization).toBe('Bearer re_test')
        expect(init.headers['Content-Type']).toBe('application/json')
        expect(JSON.parse(init.body)).toEqual({
            from: 'onboarding@resend.dev',
            to: ['to@example.com'],
            subject: 'hello',
            html: '<p>hi</p>',
        })
    })

    it('throws the API message when Resend rejects the send', async () => {
        globalThis.fetch = (async () =>
            jsonResponse({ message: 'Invalid API key' }, false, 401)) as any

        const plugin = new ResendPlugin({ apiKey: 're_test' })
        await expect(
            plugin.sendEmail('a@b.c', ['d@e.f'], 's', '<p>x</p>')
        ).rejects.toThrow('Invalid API key')
    })

    it('falls back to a generic error when the API gives no message', async () => {
        globalThis.fetch = (async () => jsonResponse({}, false, 500)) as any

        const plugin = new ResendPlugin({ apiKey: 're_test' })
        await expect(
            plugin.sendEmail('a@b.c', ['d@e.f'], 's', '<p>x</p>')
        ).rejects.toThrow('Failed to send email')
    })
})
