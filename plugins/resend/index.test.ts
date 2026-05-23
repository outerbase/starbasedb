import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResendPlugin } from './index'

const fetchMock = vi.fn()

describe('ResendPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('fetch', fetchMock)
    })

    it('initializes as an authless plugin and stores the API key', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test_key' })

        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.apiKey).toBe('re_test_key')
    })

    it('posts email payloads to Resend with bearer auth', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: vi.fn().mockResolvedValue({
                id: 'email_123',
                from: 'hello@example.com',
            }),
        })

        const plugin = new ResendPlugin({ apiKey: 're_live_key' })
        const result = await plugin.sendEmail(
            'hello@example.com',
            ['ada@example.com', 'grace@example.com'],
            'Welcome',
            '<p>Hello</p>'
        )

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer re_live_key',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'hello@example.com',
                    to: ['ada@example.com', 'grace@example.com'],
                    subject: 'Welcome',
                    html: '<p>Hello</p>',
                }),
            }
        )
        expect(result).toEqual({
            id: 'email_123',
            from: 'hello@example.com',
        })
    })

    it('throws the Resend error message when the API rejects the request', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            json: vi.fn().mockResolvedValue({
                message: 'Invalid API key',
            }),
        })

        const plugin = new ResendPlugin({ apiKey: 'bad_key' })

        await expect(
            plugin.sendEmail(
                'hello@example.com',
                ['ada@example.com'],
                'Welcome',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Invalid API key')
    })

    it('uses a fallback error when Resend returns no message', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            json: vi.fn().mockResolvedValue({}),
        })

        const plugin = new ResendPlugin({ apiKey: 'bad_key' })

        await expect(
            plugin.sendEmail(
                'hello@example.com',
                ['ada@example.com'],
                'Welcome',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Failed to send email')
    })
})
