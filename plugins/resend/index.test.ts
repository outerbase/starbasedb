import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ResendPlugin } from './index'

let resendPlugin: ResendPlugin
const mockApiKey = 'mock-api-key'

beforeEach(() => {
    vi.clearAllMocks()
    resendPlugin = new ResendPlugin({ apiKey: mockApiKey })
})

describe('ResendPlugin - Initialization', () => {
    it('should initialize with the given API key', () => {
        expect(resendPlugin.apiKey).toBe(mockApiKey)
    })

    it('should initialize even if no API key is provided', () => {
        const plugin = new ResendPlugin()
        expect(plugin.apiKey).toBeUndefined()
    })
})

describe('ResendPlugin - sendEmail', () => {
    const mockFetch = vi.fn()

    beforeEach(() => {
        global.fetch = mockFetch as any
    })

    it('should send an email successfully', async () => {
        const mockResponse = {
            id: 'email-123',
            status: 'queued',
        }

        mockFetch.mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue(mockResponse),
        })

        const result = await resendPlugin.sendEmail(
            'test@example.com',
            ['recipient@example.com'],
            'Test Subject',
            '<h1>Hello</h1>'
        )

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
                    from: 'test@example.com',
                    to: ['recipient@example.com'],
                    subject: 'Test Subject',
                    html: '<h1>Hello</h1>',
                }),
            }
        )
        expect(result).toEqual(mockResponse)
    })

    it('should throw an error when API call fails', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({ message: 'Invalid API key' }),
        })

        await expect(
            resendPlugin.sendEmail(
                'test@example.com',
                ['recipient@example.com'],
                'Test Subject',
                '<h1>Hello</h1>'
            )
        ).rejects.toThrow('Invalid API key')

        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should throw a generic error if API response lacks an error message', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({}),
        })

        await expect(
            resendPlugin.sendEmail(
                'test@example.com',
                ['recipient@example.com'],
                'Test Subject',
                '<h1>Hello</h1>'
            )
        ).rejects.toThrow('Failed to send email')

        expect(mockFetch).toHaveBeenCalledTimes(1)
    })
})
