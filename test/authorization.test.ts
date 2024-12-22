import { describe, it, expect } from 'vitest'

describe('Authorization', () => {
    const baseUrl = 'http://127.0.0.1:8787'

    it('should return 200 for valid admin Authorization header', async () => {
        const response = await fetch(`${baseUrl}/query`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ABC123',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sql: 'SELECT 1 + 1',
                params: [],
            }),
        })

        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data).toEqual({ result: [{ '1 + 1': 2 }] })
    })

    it('should return 200 for valid client Authorization header', async () => {
        const response = await fetch(`${baseUrl}/query`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer DEF456',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sql: 'SELECT 1 + 1',
                params: [],
            }),
        })

        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data).toEqual({ result: [{ '1 + 1': 2 }] })
    })

    it('should return 400 for invalid Authorization header', async () => {
        const response = await fetch(`${baseUrl}/query`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer INVALID-TOKEN',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sql: 'SELECT 1 + 1',
                params: [],
            }),
        })

        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data).toEqual({ error: 'Unauthorized request' })
    })
})
