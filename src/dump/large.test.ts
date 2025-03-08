import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseDumper } from './index'
import { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Large Database Tests (>1GB)', () => {
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
                executeQuery: vi.fn().mockImplementation(async (query) => {
                    if (query.sql.includes('set_alarm')) return []
                    if (query.sql.includes('sqlite_master')) {
                        return [
                            { name: 'users', sql: 'CREATE TABLE users...' },
                            { name: 'posts', sql: 'CREATE TABLE posts...' },
                            {
                                name: 'comments',
                                sql: 'CREATE TABLE comments...',
                            },
                            { name: 'likes', sql: 'CREATE TABLE likes...' },
                        ]
                    }
                    if (query.sql.includes('COUNT')) {
                        return [{ count: 5000000 }] // Large database (5M rows)
                    }
                    return [
                        { id: 1, name: 'User 1' },
                        { id: 2, name: 'User 2' },
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
    })

    it('should use breathing intervals for large databases', async () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'large-test' },
            mockEnv
        )

        await dumper.start()

        // Should write to R2
        expect(mockR2Bucket.put).toHaveBeenCalled()

        // Should use breathing intervals for large databases
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('set_alarm'),
            })
        )
    })
})
