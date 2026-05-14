import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ResendPlugin } from './index'

let resendPlugin: ResendPlugin

beforeEach(() => {
    vi.clearAllMocks()
    resendPlugin = new ResendPlugin({ apiKey: 'test-api-key' })
    vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('ResendPlugin - Initialization', () => {
    it('should initialize with the configured API key', () => {
        expect(resendPlugin).toBeInstanceOf(ResendPlugin)
        expect(resendPlugin.apiKey).toBe('test-api-key')
    })

    it('should allow initialization without options', () => {
        const plugin = new ResendPlugin()

        expect(plugin.apiKey).toBeUndefined()
    })
})

describe('ResendPlugin - sendEmail()', () => {
    it('should send email requests to the Resend API', async () => {
        const responsePayload = { id: 'email_123' }
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(JSON.stringify(responsePayload), { status: 200 })
        )

        const result = await resendPlugin.sendEmail(
            'hello@example.com',
            ['customer@example.com'],
            'Welcome',
            '<p>Hello</p>'
        )

        expect(fetch).toHaveBeenCalledWith('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-api-key',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'hello@example.com',
                to: ['customer@example.com'],
                subject: 'Welcome',
                html: '<p>Hello</p>',
            }),
        })
        expect(result).toEqual(responsePayload)
    })

    it('should throw the Resend error message when the request fails', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ message: 'Invalid API key' }), {
                status: 401,
            })
        )

        await expect(
            resendPlugin.sendEmail(
                'hello@example.com',
                ['customer@example.com'],
                'Welcome',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Invalid API key')
    })

    it('should throw a fallback message when Resend omits an error message', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({}), { status: 500 })
        )

        await expect(
            resendPlugin.sendEmail(
                'hello@example.com',
                ['customer@example.com'],
                'Welcome',
                '<p>Hello</p>'
            )
        ).rejects.toThrow('Failed to send email')
    })
})
