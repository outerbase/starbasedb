import { describe, it, expect, vi, afterEach } from 'vitest'
import { ResendPlugin } from './index'

describe('ResendPlugin', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('stores the provided api key', () => {
        const plugin = new ResendPlugin({ apiKey: 'test-key' })
        expect(plugin.apiKey).toBe('test-key')
    })

    it('is constructible without options (no api key)', () => {
        const plugin = new ResendPlugin()
        expect(plugin.apiKey).toBeUndefined()
    })

    it('sendEmail posts to the Resend API and returns the response data on success', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ id: 'email_123' }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const plugin = new ResendPlugin({ apiKey: 'test-key' })
        const result = await plugin.sendEmail(
            'from@example.com',
            ['to@example.com'],
            'Subject',
            '<p>Hello</p>'
        )

        expect(result).toEqual({ id: 'email_123' })
        expect(fetchMock).toHaveBeenCalledOnce()

        const [url, options] = fetchMock.mock.calls[0]
        expect(url).toBe('https://api.resend.com/emails')
        expect(options.method).toBe('POST')
        expect(options.headers.Authorization).toBe('Bearer test-key')
        expect(JSON.parse(options.body)).toEqual({
            from: 'from@example.com',
            to: ['to@example.com'],
            subject: 'Subject',
            html: '<p>Hello</p>',
        })
    })

    it('sendEmail throws with the API error message when the response is not ok', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({ message: 'Invalid API key' }),
        })
        vi.stubGlobal('fetch', fetchMock)

        const plugin = new ResendPlugin({ apiKey: 'bad-key' })
        await expect(
            plugin.sendEmail('a@b.com', ['c@d.com'], 'S', '<p>x</p>')
        ).rejects.toThrow('Invalid API key')
    })

    it('sendEmail throws a default message when the error response has no message', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
            json: async () => ({}),
        })
        vi.stubGlobal('fetch', fetchMock)

        const plugin = new ResendPlugin({ apiKey: 'bad-key' })
        await expect(
            plugin.sendEmail('a@b.com', ['c@d.com'], 'S', '<p>x</p>')
        ).rejects.toThrow('Failed to send email')
    })
})
