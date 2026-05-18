import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    const apiKey = 're_test_123'
    const plugin = new ResendPlugin({ apiKey })

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn())
    })

    it('should initialize with correct name and auth requirement', () => {
        expect(plugin.name).toBe('starbasedb:resend')
        // @ts-ignore - checking private property or implementation detail
        expect(plugin.opts.requiresAuth).toBe(false)
    })

    it('should send an email successfully', async () => {
        const mockResponse = { id: 'email_id_123' }
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => mockResponse,
        } as Response)

        const result = await plugin.sendEmail(
            'from@example.com',
            ['to@example.com'],
            'Hello',
            '<p>Hi</p>'
        )

        expect(fetch).toHaveBeenCalledWith('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'from@example.com',
                to: ['to@example.com'],
                subject: 'Hello',
                html: '<p>Hi</p>',
            }),
        })
        expect(result).toEqual(mockResponse)
    })

    it('should throw an error if email sending fails', async () => {
        const errorMessage = 'Invalid API Key'
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: false,
            json: async () => ({ message: errorMessage }),
        } as Response)

        await expect(
            plugin.sendEmail('from@example.com', ['to@example.com'], 'Hello', 'Hi')
        ).rejects.toThrow(errorMessage)
    })

    it('should throw a default error message if response is not ok and no message provided', async () => {
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: false,
            json: async () => ({}),
        } as Response)

        await expect(
            plugin.sendEmail('from@example.com', ['to@example.com'], 'Hello', 'Hi')
        ).rejects.toThrow('Failed to send email')
    })
})
