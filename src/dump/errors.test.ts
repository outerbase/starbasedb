import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseDumper } from './index'
import { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Error Handling Tests', () => {
    let mockDataSource: DataSource
    let mockEnv: StarbaseDBConfiguration
    let mockR2Bucket: R2Bucket

    beforeEach(() => {
        vi.resetAllMocks()

        mockR2Bucket = {
            put: vi.fn().mockResolvedValue(undefined),
            get: vi.fn().mockResolvedValue(null),
            delete: vi.fn().mockResolvedValue(undefined),
        } as unknown as R2Bucket

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
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
    })

    it('should handle database query errors', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockRejectedValue(new Error('Database connection error'))

        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'error-test' },
            mockEnv
        )

        await dumper.start()

        // Should save error state
        expect(mockDataSource.storage.put).toHaveBeenCalledWith(
            'dump:error-test:state',
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('Database connection error'),
            })
        )
    })

    it('should handle R2 storage errors', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockImplementation(async (query) => {
                if (query.sql.includes('sqlite_master')) {
                    return [{ name: 'users', sql: 'CREATE TABLE users...' }]
                }
                if (query.sql.includes('COUNT')) {
                    return [{ count: 10 }]
                }
                return [{ id: 1, name: 'Test' }]
            })

        mockR2Bucket.put = vi
            .fn()
            .mockRejectedValue(new Error('R2 storage error'))

        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'r2-error-test' },
            mockEnv
        )

        await dumper.start()

        // Should save error state
        expect(mockDataSource.storage.put).toHaveBeenCalledWith(
            'dump:r2-error-test:state',
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('R2 storage error'),
            })
        )
    })

    it('should send error notification to callback URL', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockRejectedValue(new Error('Test error'))

        global.fetch = vi.fn().mockResolvedValue({ ok: true })

        const dumper = new DatabaseDumper(
            mockDataSource,
            {
                format: 'sql',
                dumpId: 'callback-error-test',
                callbackUrl: 'https://example.com/callback',
            },
            mockEnv
        )

        await dumper.start()

        // Should call callback URL with error
        expect(global.fetch).toHaveBeenCalledWith(
            'https://example.com/callback',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('failed'),
            })
        )
    })
})
