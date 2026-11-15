import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('should initialize with correct plugin name and options', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test_key_123' })
        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.apiKey).toBe('re_test_key_123')
    })

    it('should initialize without options', () => {
        const plugin = new ResendPlugin()
        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.apiKey).toBeUndefined()
    })

    it('should send email successfully with proper payload and authorization header', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_valid_api_key' })
        const mockResponse = { id: 'email_12345' }

        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => mockResponse,
        })
        global.fetch = fetchMock

        const result = await plugin.sendEmail(
            'onboarding@resend.dev',
            ['user@example.com'],
            'Welcome to Starbase',
            '<p>Hello World</p>'
        )

        expect(result).toEqual(mockResponse)
        expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer re_valid_api_key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'onboarding@resend.dev',
                to: ['user@example.com'],
                subject: 'Welcome to Starbase',
                html: '<p>Hello World</p>',
            }),
        })
    })

    it('should throw an error when API returns a non-ok response with a message', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_invalid_api_key' })

        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ message: 'Invalid API Key' }),
        })

        await expect(
            plugin.sendEmail('test@test.com', ['dest@dest.com'], 'Test', 'Body')
        ).rejects.toThrow('Invalid API Key')
    })

    it('should throw fallback error when API response lacks a message', async () => {
        const plugin = new ResendPlugin({ apiKey: 're_key' })

        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({}),
        })

        await expect(
            plugin.sendEmail('test@test.com', ['dest@dest.com'], 'Test', 'Body')
        ).rejects.toThrow('Failed to send email')
    })
})
