import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { executeOperation } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

const tableColumns = (names: string[]) =>
    names.map((name, index) => ({
        cid: index,
        name,
        type: '',
        notnull: 0,
        dflt_value: null,
        pk: name === 'id' ? 1 : 0,
    }))

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('JSON Export Module', () => {
    it('should return a 404 response if table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'missing_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe("Table 'missing_table' does not exist.")
    })

    it('should return a JSON file when table data exists', async () => {
        const mockData = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name']))
            .mockResolvedValueOnce(mockData)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual(mockData)
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name']))
            .mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual([])
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name', 'description']))
            .mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual(specialCharsData)
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Failed to export table to JSON')
    })
})
