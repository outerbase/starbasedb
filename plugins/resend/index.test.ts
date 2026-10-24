import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin - Initialization', () => {
    it('should initialize with plugin name and optional apiKey', () => {
        const pluginWithoutKey = new ResendPlugin()
        expect(pluginWithoutKey.name).toBe('starbasedb:resend')
        expect(pluginWithoutKey.opts.requiresAuth).toBe(false)
        expect(pluginWithoutKey.apiKey).toBeUndefined()

        const pluginWithKey = new ResendPlugin({ apiKey: 're_test_12345' })
        expect(pluginWithKey.apiKey).toBe('re_test_12345')
    })
})

describe('ResendPlugin - sendEmail()', () => {
    const mockApiKey = 're_test_key_987'
    let plugin: ResendPlugin

    beforeEach(() => {
        vi.restoreAllMocks()
        plugin = new ResendPlugin({ apiKey: mockApiKey })
    })

    it('should make POST request to Resend API with correct headers and payload', async () => {
        const mockResponseData = { id: 'email_id_123' }
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue(mockResponseData),
        })
        global.fetch = mockFetch

        const result = await plugin.sendEmail(
            'sender@example.com',
            ['recipient1@example.com', 'recipient2@example.com'],
            'Test Subject',
            '<p>Hello world</p>'
        )

        expect(result).toEqual(mockResponseData)
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(mockFetch).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${mockApiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'sender@example.com',
                    to: ['recipient1@example.com', 'recipient2@example.com'],
                    subject: 'Test Subject',
                    html: '<p>Hello world</p>',
                }),
            }
        )
    })

    it('should throw an error with API message when response is not ok', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({ message: 'Domain not verified' }),
        })
        global.fetch = mockFetch

        await expect(
            plugin.sendEmail(
                'unverified@domain.com',
                ['user@example.com'],
                'Alert',
                'Body'
            )
        ).rejects.toThrow('Domain not verified')
    })

    it('should fallback to default error message when data.message is missing', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({}),
        })
        global.fetch = mockFetch

        await expect(
            plugin.sendEmail('from@test.com', ['to@test.com'], 'Sub', 'Body')
        ).rejects.toThrow('Failed to send email')
    })
})
