import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseDumper } from './index'
import { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('DatabaseDumper', () => {
    let mockDataSource: DataSource
    let mockEnv: StarbaseDBConfiguration
    let mockR2Bucket: R2Bucket

    beforeEach(() => {
        vi.resetAllMocks()

        mockR2Bucket = {
            put: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(new Response('test data')),
            delete: vi.fn().mockResolvedValue(undefined),
        } as unknown as R2Bucket

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockImplementation(async (query) => {
                    if (query.sql.includes('set_alarm')) return []
                    return [
                        { table_name: 'users', sql: 'CREATE TABLE users...' },
                        { table_name: 'posts', sql: 'CREATE TABLE posts...' },
                    ]
                }),
            },
            storage: {
                get: vi.fn().mockResolvedValue(null),
                put: vi.fn().mockResolvedValue(undefined),
                setAlarm: vi.fn().mockResolvedValue(undefined),
            },
        }

        mockEnv = {
            BUCKET: mockR2Bucket,
            role: 'admin' as const,
            outerbaseApiKey: '',
            features: {
                allowlist: false,
                rls: false,
                rest: false,
                export: true,
                import: false,
            },
        }

        global.fetch = vi.fn().mockResolvedValue({ ok: true })
    })

    it('should initialize with correct options', () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            {
                format: 'sql',
                dumpId: 'test-dump',
                chunkSize: 100,
            },
            mockEnv
        )

        expect(dumper).toBeDefined()
    })

    it('should process chunks and store in R2', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValueOnce([
                { table_name: 'users', sql: 'CREATE TABLE users...' },
            ])
            .mockResolvedValueOnce([{ count: 100 }])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])

        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'test-dump' },
            mockEnv
        )

        await dumper.start()

        expect(mockR2Bucket.put).toHaveBeenCalled()
    })

    it('should handle large datasets with breathing intervals', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValueOnce([
                { table_name: 'users', sql: 'CREATE TABLE users...' },
            ])
            .mockResolvedValueOnce([{ count: 2000 }])
            .mockResolvedValueOnce([{ id: 1, name: 'User 1' }])
            .mockResolvedValueOnce([])

        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'test-dump' },
            mockEnv
        )

        await dumper.start()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT set_alarm(?)',
            params: expect.any(Array),
        })
    })

    it('should send callback notification when complete', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValue([])

        const dumper = new DatabaseDumper(
            mockDataSource,
            {
                format: 'sql',
                dumpId: 'test-dump',
                chunkSize: 100,
                callbackUrl: 'https://example.com/callback',
            },
            mockEnv
        )

        await dumper.start()

        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com/callback',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                }),
            })
        )
    })

    it('should handle different export formats', async () => {
        const formats = ['sql', 'csv', 'json'] as const

        for (const format of formats) {
            mockDataSource.rpc.executeQuery = vi
                .fn()
                .mockResolvedValueOnce([
                    { id: 1, name: 'Test' },
                    { id: 2, name: 'Test2' },
                ])
                .mockResolvedValue([])

            const dumper = new DatabaseDumper(
                mockDataSource,
                {
                    format,
                    dumpId: `test-dump-${format}`,
                    chunkSize: 100,
                },
                mockEnv
            )

            await dumper.start()
        }

        expect(mockR2Bucket.put).toHaveBeenCalled()
    })

    it('should resume from saved state', async () => {
        const mockGet = vi.fn().mockResolvedValueOnce({
            id: 'test-dump',
            status: 'processing',
            currentOffset: 100,
            totalRows: 200,
            format: 'sql',
        })

        mockDataSource.storage.get = mockGet

        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValueOnce([
                { table_name: 'users', sql: 'CREATE TABLE users...' },
            ])
            .mockResolvedValue([])

        await DatabaseDumper.continueProcessing(mockDataSource, mockEnv)

        expect(mockR2Bucket.put).toHaveBeenCalled()
    })
})
