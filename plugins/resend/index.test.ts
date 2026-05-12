import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends email requests with the configured API key and payload', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ id: 'email_123' }), {
                status: 200,
            })
        )
        vi.stubGlobal('fetch', fetchMock)

        const plugin = new ResendPlugin({ apiKey: 'resend-secret' })
        const response = await plugin.sendEmail(
            'from@example.com',
            ['to@example.com'],
            'Subject',
            '<p>Hello</p>'
        )

        expect(response).toEqual({ id: 'email_123' })
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer resend-secret',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'from@example.com',
                    to: ['to@example.com'],
                    subject: 'Subject',
                    html: '<p>Hello</p>',
                }),
            }
        )
    })

    it('throws the Resend error message when the API rejects the request', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ message: 'Invalid API key' }), {
                    status: 401,
                })
            )
        )

        const plugin = new ResendPlugin({ apiKey: 'bad-key' })

        await expect(
            plugin.sendEmail(
                'from@example.com',
                ['to@example.com'],
                'Subject',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Invalid API key')
    })

    it('uses a fallback error message when the API error body has no message', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({}), {
                    status: 500,
                })
            )
        )

        const plugin = new ResendPlugin({ apiKey: 'resend-secret' })

        await expect(
            plugin.sendEmail(
                'from@example.com',
                ['to@example.com'],
                'Subject',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Failed to send email')
    })
})
