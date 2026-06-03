import { describe, it, expect, vi } from 'vitest'
import { importTableFromCsvRoute } from './csv'

const mockDataSource = {} as any
const mockConfig = {} as any

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

describe('CSV Import Route', () => {
    it('returns 400 when request body is empty', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
    })
})

it('returns 400 for unsupported content type', async () => {
    const request = new Request('http://localhost', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/xml',
        },
        body: '<xml></xml>',
    })

    const response = await importTableFromCsvRoute(
        'users',
        request,
        mockDataSource,
        mockConfig
    )

    expect(response.status).toBe(400)
})
