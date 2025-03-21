import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseDumper } from './index'
import { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Breathing Interval Tests', () => {
    let mockDataSource: DataSource
    let mockEnv: StarbaseDBConfiguration
    let mockR2Bucket: R2Bucket

    beforeEach(() => {
        vi.resetAllMocks()
        vi.useFakeTimers()

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
                        return [{ name: 'users', sql: 'CREATE TABLE users...' }]
                    }
                    if (query.sql.includes('COUNT')) {
                        return [{ count: 2000 }]
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

    afterEach(() => {
        vi.useRealTimers()
    })

    it('should schedule next run after timeout', async () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'breathing-test' },
            mockEnv
        )

        // Advance time to trigger breathing interval
        vi.advanceTimersByTime(26000)

        await dumper.start()

        // Should schedule next run
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('set_alarm'),
            })
        )
    })

    it('should continue processing after alarm', async () => {
        // Mock state for continuation
        mockDataSource.storage.get = vi.fn().mockImplementation((key) => {
            if (key === 'dump:last_active') return 'breathing-test'
            if (key === 'dump:breathing-test:state') {
                return {
                    id: 'breathing-test',
                    status: 'processing',
                    currentOffset: 100,
                    totalRows: 2000,
                    format: 'sql',
                    tables: ['users'],
                    processedTables: [],
                    currentTable: 'users',
                }
            }
            return null
        })

        await DatabaseDumper.continueProcessing(mockDataSource, mockEnv)

        // Should write to R2 when continuing
        expect(mockR2Bucket.put).toHaveBeenCalled()
    })
})
