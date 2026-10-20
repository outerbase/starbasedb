import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('should initialize with plugin name and API key', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test_key_123' })
        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.apiKey).toBe('re_test_key_123')
    })

    it('should successfully send an email via Resend API', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_valid_key' })
        const mockResponse = { id: 'email_abc123' }

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        }) as any

        const result = await plugin.sendEmail(
            'onboarding@example.com',
            ['user@example.com'],
            'Welcome!',
            '<p>Hello World</p>'
        )

        expect(result).toEqual(mockResponse)
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer re_valid_key',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'onboarding@example.com',
                    to: ['user@example.com'],
                    subject: 'Welcome!',
                    html: '<p>Hello World</p>',
                }),
            }
        )
    })

    it('should throw an error when Resend API returns non-ok response', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_invalid_key' })

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ message: 'Invalid API Key' }),
        }) as any

        await expect(
            plugin.sendEmail(
                'test@example.com',
                ['test@example.com'],
                'Test',
                '<p>Test</p>'
            )
        ).rejects.toThrow('Invalid API Key')
    })

    it('should fallback to default error message when response message is missing', async () => {
        const plugin = new ResendPlugin()

        globalThis.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({}),
        }) as any

        await expect(
            plugin.sendEmail(
                'test@example.com',
                ['test@example.com'],
                'Test',
                '<p>Test</p>'
            )
        ).rejects.toThrow('Failed to send email')
    })
})
