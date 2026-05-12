import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResendPlugin } from './index'

const mockFetch = (response: { ok: boolean; json: () => Promise<unknown> }) => {
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}

describe('ResendPlugin', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('stores the configured API key', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test' })

        expect(plugin.apiKey).toBe('re_test')
    })

    it('sends email requests to Resend with authorization and JSON body', async () => {
        const responseBody = { id: 'email_123' }
        const fetchMock = mockFetch({
            ok: true,
            json: async () => responseBody,
        })
        const plugin = new ResendPlugin({ apiKey: 're_test' })

        await expect(
            plugin.sendEmail(
                'sender@example.com',
                ['ada@example.com', 'grace@example.com'],
                'Welcome',
                '<strong>Hello</strong>'
            )
        ).resolves.toBe(responseBody)

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer re_test',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'sender@example.com',
                    to: ['ada@example.com', 'grace@example.com'],
                    subject: 'Welcome',
                    html: '<strong>Hello</strong>',
                }),
            }
        )
    })

    it('throws the provider message when Resend rejects the request', async () => {
        mockFetch({
            ok: false,
            json: async () => ({ message: 'Invalid API key' }),
        })
        const plugin = new ResendPlugin({ apiKey: 'bad_key' })

        await expect(
            plugin.sendEmail(
                'sender@example.com',
                ['ada@example.com'],
                'Welcome',
                '<strong>Hello</strong>'
            )
        ).rejects.toThrow('Invalid API key')
    })

    it('throws a fallback error when Resend does not provide a message', async () => {
        mockFetch({
            ok: false,
            json: async () => ({ error: 'unknown' }),
        })
        const plugin = new ResendPlugin({ apiKey: 're_test' })

        await expect(
            plugin.sendEmail(
                'sender@example.com',
                ['ada@example.com'],
                'Welcome',
                '<strong>Hello</strong>'
            )
        ).rejects.toThrow('Failed to send email')
    })

    it('uses an undefined API key consistently when none is configured', async () => {
        const fetchMock = mockFetch({
            ok: true,
            json: async () => ({ id: 'email_123' }),
        })
        const plugin = new ResendPlugin()

        await plugin.sendEmail(
            'sender@example.com',
            ['ada@example.com'],
            'Welcome',
            '<strong>Hello</strong>'
        )

        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer undefined',
                }),
            })
        )
    })
})
