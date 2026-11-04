import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin - Initialization', () => {
    it('should initialize with correct plugin name and options', () => {
        const plugin = new ResendPlugin({ apiKey: 're_test_123' })
        expect(plugin).toBeInstanceOf(ResendPlugin)
        expect(plugin.name).toBe('starbasedb:resend')
        expect(plugin.apiKey).toBe('re_test_123')
        expect(plugin.options?.requiresAuth).toBe(false)
    })

    it('should initialize without options and have undefined apiKey', () => {
        const plugin = new ResendPlugin()
        expect(plugin).toBeInstanceOf(ResendPlugin)
        expect(plugin.apiKey).toBeUndefined()
        expect(plugin.options?.requiresAuth).toBe(false)
    })
})

describe('ResendPlugin - sendEmail()', () => {
    const mockApiKey = 're_test_secret_key'
    let plugin: ResendPlugin

    beforeEach(() => {
        vi.clearAllMocks()
        plugin = new ResendPlugin({ apiKey: mockApiKey })
    })

    it('should send email successfully with correct headers and payload', async () => {
        const mockSuccessResponse = {
            id: 're_msg_123456789',
        }

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue(mockSuccessResponse),
        })
        vi.stubGlobal('fetch', fetchSpy)

        const from = 'onboarding@resend.dev'
        const to = ['user@example.com', 'admin@example.com']
        const subject = 'Welcome to Starbase'
        const html = '<p>Hello StarbaseDB!</p>'

        const result = await plugin.sendEmail(from, to, subject, html)

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${mockApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to,
                subject,
                html,
            }),
        })

        expect(result).toEqual(mockSuccessResponse)
    })

    it('should throw an error with API message when response is not ok', async () => {
        const mockErrorResponse = {
            message: 'Invalid API key provided',
            statusCode: 401,
        }

        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: vi.fn().mockResolvedValue(mockErrorResponse),
        })
        vi.stubGlobal('fetch', fetchSpy)

        await expect(
            plugin.sendEmail(
                'from@test.com',
                ['to@test.com'],
                'Test Subject',
                '<p>Test</p>'
            )
        ).rejects.toThrow('Invalid API key provided')
    })

    it('should throw fallback error message when response is not ok and no message is returned', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: vi.fn().mockResolvedValue({}),
        })
        vi.stubGlobal('fetch', fetchSpy)

        await expect(
            plugin.sendEmail(
                'from@test.com',
                ['to@test.com'],
                'Test Subject',
                '<p>Test</p>'
            )
        ).rejects.toThrow('Failed to send email')
    })
})
