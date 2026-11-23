import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    let plugin: ResendPlugin

    beforeEach(() => {
        vi.clearAllMocks()
        plugin = new ResendPlugin({ apiKey: 're_test_key_123' })
    })

    describe('Initialization', () => {
        it('should initialize with correct plugin name and options', () => {
            expect(plugin.name).toBe('starbasedb:resend')
            expect(plugin.options?.requiresAuth).toBe(false)
            expect(plugin.apiKey).toBe('re_test_key_123')
        })

        it('should handle initialization without options', () => {
            const noOptPlugin = new ResendPlugin()
            expect(noOptPlugin.apiKey).toBeUndefined()
        })
    })

    describe('sendEmail', () => {
        it('should successfully send an email and return JSON data', async () => {
            const mockResponseData = { id: 'email_abc_123', from: 'onboarding@resend.dev' }
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue(mockResponseData),
            } as unknown as Response)

            const result = await plugin.sendEmail(
                'onboarding@resend.dev',
                ['user@example.com'],
                'Test Subject',
                '<p>Hello World</p>'
            )

            expect(global.fetch).toHaveBeenCalledTimes(1)
            expect(global.fetch).toHaveBeenCalledWith('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer re_test_key_123',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: 'onboarding@resend.dev',
                    to: ['user@example.com'],
                    subject: 'Test Subject',
                    html: '<p>Hello World</p>',
                }),
            })
            expect(result).toEqual(mockResponseData)
        })

        it('should throw an error with API message when response is not ok', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                json: vi.fn().mockResolvedValue({ message: 'Invalid API key provided' }),
            } as unknown as Response)

            await expect(
                plugin.sendEmail('from@test.com', ['to@test.com'], 'Sub', 'Body')
            ).rejects.toThrow('Invalid API key provided')
        })

        it('should throw fallback error when response is not ok and no message is provided', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                json: vi.fn().mockResolvedValue({}),
            } as unknown as Response)

            await expect(
                plugin.sendEmail('from@test.com', ['to@test.com'], 'Sub', 'Body')
            ).rejects.toThrow('Failed to send email')
        })
    })
})
