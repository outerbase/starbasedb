import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseDumper } from './index'
import { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Format Tests', () => {
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
                        return [{ name: 'users', sql: 'CREATE TABLE users...' }]
                    }
                    if (query.sql.includes('COUNT')) {
                        return [{ count: 10 }]
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

    it('should format SQL correctly', async () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'sql', dumpId: 'sql-test' },
            mockEnv
        )

        await dumper.start()

        // Verify SQL format
        expect(mockR2Bucket.put).toHaveBeenCalledWith(
            'sql-test.sql',
            expect.stringContaining('INSERT INTO')
        )
    })

    it('should format CSV correctly', async () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'csv', dumpId: 'csv-test' },
            mockEnv
        )

        await dumper.start()

        // Verify CSV format (headers + data)
        expect(mockR2Bucket.put).toHaveBeenCalledWith(
            'csv-test.csv',
            expect.stringMatching(/id,name\n1,User 1\n2,User 2/)
        )
    })

    it('should format JSON correctly', async () => {
        const dumper = new DatabaseDumper(
            mockDataSource,
            { format: 'json', dumpId: 'json-test' },
            mockEnv
        )

        await dumper.start()

        // Verify JSON format
        expect(mockR2Bucket.put).toHaveBeenCalledWith(
            'json-test.json',
            expect.stringContaining('[')
        )
    })
})
