import { describe, it, expect } from 'vitest'
import { handleApiRequest } from './index'

describe('API Request Handler', () => {
    it('should return 200 for a valid GET request', async () => {
        const request = new Request(
            'https://starbasedb.test.workers.dev/api/your/path/here',
            {
                method: 'GET',
            }
        )

        const response = await handleApiRequest(request)

        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toBe('Success')
    })

    it('should return 404 for an unknown GET request', async () => {
        const request = new Request(
            'https://starbasedb.test.workers.dev/api/unknown',
            {
                method: 'GET',
            }
        )

        const response = await handleApiRequest(request)

        expect(response.status).toBe(404)
        const text = await response.text()
        expect(text).toBe('Not found')
    })

    it('should return 404 for an unknown POST request', async () => {
        const request = new Request(
            'https://starbasedb.test.workers.dev/api/unknown',
            {
                method: 'POST',
            }
        )

        const response = await handleApiRequest(request)

        expect(response.status).toBe(404)
        const text = await response.text()
        expect(text).toBe('Not found')
    })

    it('should handle various HTTP methods correctly', async () => {
        const methods = ['PUT', 'DELETE', 'PATCH', 'OPTIONS']

        for (const method of methods) {
            const request = new Request(
                'https://starbasedb.test.workers.dev/api/your/path/here',
                {
                    method: method as RequestInit['method'],
                }
            )

            const response = await handleApiRequest(request)

            expect(response.status).toBe(404)
            const text = await response.text()
            expect(text).toBe('Not found')
        }
    })
})
